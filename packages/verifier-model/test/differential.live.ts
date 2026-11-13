// Differential test (TECH_DOC §13/§16.4): N random batches (funded and unfunded, valid and
// corrupted) through the local VerifierModel AND our testnet Verifier's simulate_intents.
// Asserts the same accept/reject outcome and error class; for invariant violations, the same
// unmatched deltas; for accepted batches, the same intent hashes.
//
// Usage: tsx packages/verifier-model/test/differential.live.ts [N=200] [seed=1]
// Needs ~/.near-credentials/testnet/nomadswarm.testnet.json (funds the agent pool once).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IntentsClient,
  buildNonce,
  feeOf,
  implicitAccountId,
  randomKeyPair,
  signIntents,
  signTokenDiff,
  signerFor,
  type Intent,
  type MultiPayload,
} from '@nomad/intents';
import { VerifierModel } from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'testnet.json'), 'utf8'));
const N = Number(process.argv[2] ?? 200);
let seed = Number(process.argv[3] ?? 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); // deterministic LCG
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const rint = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const client = new IntentsClient({ rpcUrl: CFG.rpcUrl, verifierId: CFG.verifierId });
const parent = signerFor(CFG.tokenOwner);
const TOK: string[] = CFG.tokens.map((t: any) => t.id);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- agent pool: 8 implicit agents, each funded with 2 random tokens ----
const pool = Array.from({ length: 8 }, () => {
  const kp = randomKeyPair();
  return { id: implicitAccountId(kp.publicKey), sk: kp.secretKeyStr, pk: kp.publicKeyStr };
});
const grants = pool.map((a) => {
  const ts = [...TOK].sort(() => rnd() - 0.5).slice(0, 2);
  return { to: a.id, tokens: Object.fromEntries(ts.map((t) => [t, BigInt(rint(10_000, 2_000_000))])) };
});
{
  const need: Record<string, bigint> = {};
  for (const g of grants) for (const [t, a] of Object.entries(g.tokens)) need[t] = (need[t] ?? 0n) + a;
  for (const [t, a] of Object.entries(need)) {
    if ((await client.mtBalanceOf(CFG.tokenOwner, t)) < a) {
      const r = await client.deposit(parent, t.replace('nep141:', ''), a * 10n);
      log('funder deposit', t, r.txHash, r.ok);
    }
  }
  const funding = signIntents({
    signerId: CFG.tokenOwner, secretKey: parent.secretKey, verifierId: CFG.verifierId, salt: await client.currentSalt(0),
    deadline: new Date(Date.now() + 600_000),
    intents: grants.map((g) => ({ intent: 'transfer', receiver_id: g.to, tokens: Object.fromEntries(Object.entries(g.tokens).map(([t, a]) => [t, a.toString()])) })),
  });
  const r = await client.execute([funding], parent);
  log('funded pool', r.txHash, r.ok, r.error ?? '');
  if (!r.ok) process.exit(1);
}

// ---- model seeded from chain state ----
const salt = await client.currentSalt(0);
const SALTS = [salt, '00000000', 'deadbeef'];
const valid = await Promise.all(SALTS.map((s) => client.isValidSalt(s)));
const model = new VerifierModel({ verifierId: CFG.verifierId, feePips: await client.fee(), feeCollector: await client.feeCollector(), validSalts: SALTS.filter((_, i) => valid[i]) });
for (const a of pool) {
  const bs = await client.mtBatchBalanceOf(a.id, TOK);
  bs.forEach((b, i) => b > 0n && model.deposit(a.id, TOK[i]!, b));
}
const bal = (a: string, t: string) => model.balanceOf(a, t);
const fee = model.cfg.feePips;

// ---- batch generator ----
type Agent = (typeof pool)[number];
const FUTURE = () => new Date(Date.now() + 15 * 60_000);
function legOf(a: Agent, diff: Record<string, bigint>, o: { salt?: string; deadline?: Date; nonce?: Uint8Array; verifier?: string; signer?: string } = {}): MultiPayload {
  const intents: Intent[] = [{ intent: 'token_diff', diff: Object.fromEntries(Object.entries(diff).map(([t, v]) => [t, v.toString()])) }];
  return signIntents({ signerId: o.signer ?? a.id, secretKey: a.sk, verifierId: o.verifier ?? CFG.verifierId, salt: o.salt ?? salt, deadline: o.deadline ?? FUTURE(), nonce: o.nonce, intents });
}
/** A ring over k distinct pool agents, each giving one token it holds (fee-correct). */
function ring(k: number, overdraw = false) {
  const agents = [...pool].sort(() => rnd() - 0.5).slice(0, k);
  const gives = agents.map((a) => pick(TOK.filter((t) => bal(a.id, t) > 0n) .concat(overdraw ? TOK : [])));
  const amts = agents.map((a, i) => {
    const b = bal(a.id, gives[i]!);
    return overdraw ? b + BigInt(rint(1, 1000)) : BigInt(rint(2, Math.max(2, Number(b / 2n))));
  });
  const diffs = agents.map((_, i) => {
    const d: Record<string, bigint> = {};
    const add = (t: string, v: bigint) => (d[t] = (d[t] ?? 0n) + v);
    add(gives[i]!, -amts[i]!);
    const prev = (i + k - 1) % k; // receive what the previous agent gave, net of fee
    add(gives[prev]!, amts[prev]! - feeOf(amts[prev]!, fee));
    for (const [t, v] of Object.entries(d)) if (v === 0n) delete d[t];
    return d;
  });
  return { agents, diffs };
}

const KINDS = [
  'valid-ring', 'valid-ring', 'valid-ring', 'valid-ring+matcher', 'overdraw', 'naive-no-fee', 'matcher-inflated',
  'tampered', 'zero-salt', 'unknown-salt', 'legacy-nonce', 'expired', 'wrong-recipient', 'zero-amount', 'duplicate-leg',
  'unregistered-named', 'deadline-after-nonce', 'transfer-to-self', 'valid-transfer', 'empty-diff', 'reordered-insufficient',
] as const;

function makeBatch(kind: (typeof KINDS)[number]): MultiPayload[] {
  const k = rint(2, 5);
  const { agents, diffs } = ring(k, kind === 'overdraw');
  const legs = () => agents.map((a, i) => legOf(a, diffs[i]!));
  const i = rint(0, k - 1);
  switch (kind) {
    case 'valid-ring':
    case 'overdraw':
      return legs();
    case 'valid-ring+matcher':
    case 'matcher-inflated': {
      // the last agent hands part of what it receives to a matcher
      const last = k - 1, t = Object.entries(diffs[last]!).find(([, v]) => v > 1n)?.[0];
      if (!t) return legs();
      const cut = BigInt(rint(1, Math.max(1, Number(diffs[last]![t]! / 2n))));
      diffs[last]![t]! -= cut;
      const m = pool.find((p) => !agents.includes(p))!;
      return [...legs(), legOf(m, { [t]: cut + (kind === 'matcher-inflated' ? 1n : 0n) })];
    }
    case 'naive-no-fee': {
      const ls = agents.map((a, j) => legOf(a, Object.fromEntries(Object.entries(diffs[j]!).map(([t, v]) => [t, v > 0n ? v + 1n : v]))));
      return ls;
    }
    case 'tampered': {
      const ls = legs();
      const x = structuredClone(ls[i]!);
      x.payload.message = x.payload.message.replace(/"(-?)(\d)/, (_m, s, d) => `"${s}${(Number(d) + 1) % 10 || 1}`);
      ls[i] = x;
      return ls;
    }
    case 'zero-salt':
    case 'unknown-salt': {
      const ls = legs();
      ls[i] = legOf(agents[i]!, diffs[i]!, { salt: kind === 'zero-salt' ? '00000000' : 'deadbeef' });
      return ls;
    }
    case 'legacy-nonce': {
      const ls = legs();
      ls[i] = legOf(agents[i]!, diffs[i]!, { nonce: new Uint8Array(randomBytes(32)) });
      return ls;
    }
    case 'expired': {
      const ls = legs();
      const dl = new Date(Date.now() - rint(1, 3600) * 1000);
      ls[i] = legOf(agents[i]!, diffs[i]!, { deadline: dl, nonce: buildNonce(salt, FUTURE()) });
      return ls;
    }
    case 'wrong-recipient': {
      const ls = legs();
      ls[i] = legOf(agents[i]!, diffs[i]!, { verifier: pick(['intents.near', 'intents.testnet', 'board.nomadswarm.testnet']) });
      return ls;
    }
    case 'zero-amount': {
      const ls = legs();
      ls[i] = signIntents({ signerId: agents[i]!.id, secretKey: agents[i]!.sk, verifierId: CFG.verifierId, salt, deadline: FUTURE(), intents: [{ intent: 'token_diff', diff: { ...Object.fromEntries(Object.entries(diffs[i]!).map(([t, v]) => [t, v.toString()])), [pick(TOK)]: '0' } }] });
      return ls;
    }
    case 'duplicate-leg': {
      const ls = legs();
      return [...ls, ls[i]!];
    }
    case 'unregistered-named': {
      const ls = legs();
      ls[i] = legOf(agents[i]!, diffs[i]!, { signer: pick(['k4.nomadswarm.testnet', 'nomadswarm.testnet', 'ghost.nomadswarm.testnet']) });
      return ls;
    }
    case 'deadline-after-nonce': {
      const ls = legs();
      const dl = FUTURE();
      ls[i] = legOf(agents[i]!, diffs[i]!, { deadline: dl, nonce: buildNonce(salt, new Date(dl.getTime() - rint(1, 600) * 1000)) });
      return ls;
    }
    case 'transfer-to-self':
    case 'valid-transfer': {
      const a = agents[0]!, t = TOK.find((x) => bal(a.id, x) > 0n)!;
      const to = kind === 'transfer-to-self' ? a.id : agents[1]!.id;
      return [signIntents({ signerId: a.id, secretKey: a.sk, verifierId: CFG.verifierId, salt, deadline: FUTURE(), intents: [{ intent: 'transfer', receiver_id: to, tokens: { [t]: String(rint(1, 1000)) } }] })];
    }
    case 'empty-diff': {
      const ls = legs();
      ls[i] = signIntents({ signerId: agents[i]!.id, secretKey: agents[i]!.sk, verifierId: CFG.verifierId, salt, deadline: FUTURE(), intents: [{ intent: 'token_diff', diff: {} }] });
      return ls;
    }
    case 'reordered-insufficient': {
      // move a leg that spends what it only receives within the batch ahead of its funder
      const ls = legs();
      return ls.reverse();
    }
  }
}

// ---- run ----
const rows: any[] = [];
let mismatches = 0;
const queue = Array.from({ length: N }, (_, j) => ({ j, kind: KINDS[j % KINDS.length]! }));
async function worker() {
  for (let q = queue.shift(); q; q = queue.shift()) {
    const batch = makeBatch(q.kind);
    const m = model.simulate(batch);
    const c = await client.simulate(batch);
    const sameOutcome = m.ok === c.ok;
    const sameClass = m.ok || m.errorClass === c.errorClass;
    const sameUnmatched = m.errorClass !== 'invariant violated' || JSON.stringify(m.invariantViolated?.unmatched_deltas) === JSON.stringify(sortObj((c.invariantViolated as any)?.unmatched_deltas));
    const sameHashes = !m.ok || JSON.stringify(m.intentsExecuted.map((x) => x.intent_hash)) === JSON.stringify(c.intentsExecuted?.map((x) => x.intent_hash));
    const agree = sameOutcome && sameClass && sameUnmatched && sameHashes;
    if (!agree) {
      mismatches++;
      log('MISMATCH', q.j, q.kind, { model: [m.ok, m.error], chain: [c.ok, c.error] });
    }
    rows.push({ i: q.j, kind: q.kind, legs: batch.length, model: { ok: m.ok, errorClass: m.errorClass }, chain: { ok: c.ok, errorClass: c.errorClass, error: c.ok ? undefined : c.error?.slice(0, 160) }, agree });
  }
}
function sortObj(o: Record<string, string> | undefined) {
  return o && Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}
await Promise.all(Array.from({ length: 6 }, worker));
rows.sort((a, b) => a.i - b.i);

const byKind: Record<string, { n: number; accepted: number; agree: number; classes: Record<string, number> }> = {};
for (const r of rows) {
  const s = (byKind[r.kind] ??= { n: 0, accepted: 0, agree: 0, classes: {} });
  s.n++;
  if (r.chain.ok) s.accepted++;
  if (r.agree) s.agree++;
  const cls = r.chain.ok ? 'accepted' : r.chain.errorClass;
  s.classes[cls] = (s.classes[cls] ?? 0) + 1;
}
const out = {
  measuredAt: new Date().toISOString(), network: 'testnet', verifier: CFG.verifierId, N, seed: Number(process.argv[3] ?? 1),
  agree: rows.filter((r) => r.agree).length, mismatches, accepted: rows.filter((r) => r.chain.ok).length, byKind, rows,
};
mkdirSync(join(ROOT, 'docs', 'measurements'), { recursive: true });
writeFileSync(join(ROOT, 'docs', 'measurements', 'differential.json'), JSON.stringify(out, null, 2) + '\n');
log(`differential: ${out.agree}/${N} agree, ${out.accepted} accepted by the chain, ${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
