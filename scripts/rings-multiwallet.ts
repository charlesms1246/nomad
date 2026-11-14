// Nomad v2 with mixed wallet standards: a NEAR agent (nep413), an Ethereum-style key (erc191) and a
// Solana-style key (raw_ed25519) trade in one ring through rings.nomadswarm.testnet, and a stranger
// (k4.nomadswarm.testnet) closes it. One execute_intents (called by the contract) settles every leg;
// the closer is paid the tips.
//   propose_ring  by intents-matcher-1 (any account can propose)
//   attach_leg    a01 attaches its own; intents-matcher-1 relays the 0x and hex legs (any account can relay)
//   close_ring    by k4 (not one of the agents)
// Usage (repo root): packages/intents/node_modules/.bin/tsx scripts/rings-multiwallet.ts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ONE_NEAR,
  TGAS,
  ethAddressOf,
  hexencode,
  rawEd25519AccountId,
  signErc191Intents,
  signIntents,
  signRawEd25519Intents,
  signerFor,
  verifyAnyPayload,
  verifyPayload,
  type Intent,
} from '../packages/intents/src/index.js';
import { CONFIG, PARENT, ROOT, T, client, contractOf, explorer, log, rpc } from './k-lib.js';

const RINGS = 'rings.nomadswarm.testnet';
const RELAY = `intents-matcher-1.${PARENT}`;
const CLOSER = process.argv.includes('--closer') ? process.argv[process.argv.indexOf('--closer') + 1]! : `k4.${PARENT}`;
const X = 1_000_000n; // 1 USDC, 1 USDT, 0.01 ZEC (testnet tokens)
const TIP = 1_000n; // 0.1% of each leg, paid to whoever closes the ring
const toks = [T.USDC!.id, T.USDT!.id, T.ZEC!.id];

const keysDir = join(ROOT, 'keys');
mkdirSync(keysDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const ethKey = new Uint8Array(randomBytes(32));
const solSeed = new Uint8Array(randomBytes(32));
const a01Key = JSON.parse(readFileSync(join(keysDir, 'a01.nomadswarm.testnet.intents.json'), 'utf8')) as { account_id: string; private_key: string };
writeFileSync(
  join(keysDir, `rings-multiwallet-${runId}.json`),
  JSON.stringify({ erc191: { account_id: ethAddressOf(ethKey), private_key_hex: hexencode(ethKey) }, raw_ed25519: { account_id: rawEd25519AccountId(solSeed), seed_hex: hexencode(solSeed) } }, null, 2),
);
const wallets = [
  { id: a01Key.account_id, standard: 'nep413', relay: a01Key.account_id },
  { id: ethAddressOf(ethKey), standard: 'erc191', relay: RELAY },
  { id: rawEd25519AccountId(solSeed), standard: 'raw_ed25519', relay: RELAY },
] as const;
log('wallets', wallets.map((w) => `${w.standard}=${w.id}`).join('  '));

const out: Record<string, unknown> = { at: new Date().toISOString(), network: 'testnet', rings: RINGS, verifier: CONFIG.verifierId, closer: CLOSER };

// --- fund each wallet with its give amount plus its tip ---
const funder = signerFor(PARENT);
const fundingTxs: string[] = [];
for (const [i, w] of wallets.entries()) {
  const r = await client.deposit(funder, contractOf(toks[i]!), X + TIP, w.id);
  log(`deposit ${X + TIP} ${toks[i]} -> ${w.id}: ${r.txHash} ok=${r.ok}${r.error ? ' ' + r.error : ''}`);
  if (!r.ok) throw new Error('funding failed');
  fundingTxs.push(r.txHash);
}
out.fundingTxs = fundingTxs;

// --- the ring: each gives X and gets X − fee of the next token; no matcher leg ---
const fee = await client.fee();
const feeOf = (x: bigint) => (x * BigInt(fee) + 999_999n) / 1_000_000n;
const legs = wallets.map((w, i) => ({
  agent: w.id,
  give: toks[i]!,
  give_amt: X.toString(),
  get: toks[(i + 1) % 3]!,
  get_amt: (X - feeOf(X)).toString(),
  tip: { token: toks[i]!, amt: TIP.toString() },
}));
const problem = await rpc.view<string | null>(RINGS, 'check_ring_view', { legs });
if (problem) throw new Error(`ring rejected by check_ring_view: ${problem}`);
const deadlineMs = Date.now() + 10 * 60_000;
out.legs = legs;

const p = await rpc.sendTx(signerFor(RELAY), RINGS, [{ type: 'FunctionCall', methodName: 'propose_ring', args: { legs, deadline_ms: deadlineMs }, gas: 50n * TGAS, deposit: ONE_NEAR / 10n }]);
if (!p.ok) throw new Error(`propose failed: ${p.error}`);
const ringId = JSON.parse(p.returnValue!) as string;
log(`proposed ${ringId} by ${RELAY}: ${p.txHash}`);
out.ringId = ringId;
out.proposer = RELAY;
out.proposeTx = p.txHash;

// --- each wallet signs its own leg in its own standard; attach via the contract ---
const salt = await client.currentSalt();
const deadline = new Date(deadlineMs);
const intentsFor = (l: (typeof legs)[number]): Intent[] => [
  { intent: 'token_diff', diff: { [l.give]: `-${l.give_amt}`, [l.get]: l.get_amt } },
  { intent: 'transfer', receiver_id: RINGS, tokens: { [l.tip.token]: l.tip.amt } },
];
const signed = [
  signIntents({ signerId: a01Key.account_id, secretKey: a01Key.private_key, verifierId: CONFIG.verifierId, salt, deadline, intents: intentsFor(legs[0]!) }),
  signErc191Intents({ privateKey: ethKey, verifierId: CONFIG.verifierId, salt, deadline, intents: intentsFor(legs[1]!) }),
  signRawEd25519Intents({ seed: solSeed, verifierId: CONFIG.verifierId, salt, deadline, intents: intentsFor(legs[2]!) }),
];
const localOk = [verifyPayload(signed[0]!), verifyAnyPayload(signed[1]!), verifyAnyPayload(signed[2]!)];
log('local signature checks', localOk);
if (!localOk.every(Boolean)) throw new Error('a leg failed its local signature check');

const attachTxs: { index: number; agent: string; standard: string; relayedBy: string; tx: string }[] = [];
for (const [i, w] of wallets.entries()) {
  const a = await rpc.sendTx(signerFor(w.relay), RINGS, [
    { type: 'FunctionCall', methodName: 'attach_leg', args: { ring_id: ringId, index: i, signed: JSON.stringify(signed[i]) }, gas: 50n * TGAS, deposit: ONE_NEAR / 20n },
  ]);
  if (!a.ok) throw new Error(`attach ${i} failed: ${a.error}`);
  log(`attached leg ${i} (${w.standard}, relayed by ${w.relay}): ${a.txHash}`);
  attachTxs.push({ index: i, agent: w.id, standard: w.standard, relayedBy: w.relay, tx: a.txHash });
}
out.attachTxs = attachTxs;

// --- a stranger closes it ---
const watch = [...wallets.map((w) => w.id), CLOSER];
const snapshot = async () => {
  const o: Record<string, Record<string, string>> = {};
  for (const a of watch) o[a] = Object.fromEntries((await client.mtBatchBalanceOf(a, toks)).map((b, i) => [toks[i]!, b.toString()]));
  return o;
};
const before = await snapshot();
const c = await rpc.sendTx(signerFor(CLOSER), RINGS, [{ type: 'FunctionCall', methodName: 'close_ring', args: { ring_id: ringId }, gas: 300n * TGAS, deposit: 0n }]);
log(`close by ${CLOSER}: ${c.ok ? 'ok' : 'FAILED ' + c.error} ${c.txHash} returned ${c.returnValue}`);
out.closeTx = c.txHash;
out.closeExplorer = explorer(c.txHash);
out.closeReturn = c.returnValue;
await new Promise((r) => setTimeout(r, 4000)); // tip mt_transfers are detached receipts
const after = await snapshot();
const ring = await rpc.view<{ status: string; closer: string | null; standards: (string | null)[] }>(RINGS, 'get_ring', { ring_id: ringId });
const d = (a: string, t: string) => BigInt(after[a]![t]!) - BigInt(before[a]![t]!);
const moved = wallets.map((w, i) => ({ account: w.id, standard: w.standard, gave: -d(w.id, toks[i]!), got: d(w.id, toks[(i + 1) % 3]!) }));
const tipsToCloser = toks.map((t) => ({ token: t, received: d(CLOSER, t) }));
const rep = Object.fromEntries(await Promise.all(watch.map(async (a) => [a, await rpc.view(RINGS, 'reputation', { agent: a })] as const)));

const checks = {
  settled: ring.status === 'Settled',
  closerIsStranger: ring.closer === CLOSER && !wallets.some((w) => w.id === CLOSER),
  standardsRecorded: JSON.stringify(ring.standards) === JSON.stringify(wallets.map((w) => w.standard)),
  closeReturnedTrue: c.returnValue === 'true',
  eachGaveXPlusTip: moved.every((m) => m.gave === X + TIP),
  eachGotXMinusFee: moved.every((m) => m.got === X - feeOf(X)),
  closerGotEachTip: tipsToCloser.every((t) => t.received === TIP),
};
const pass = Object.values(checks).every(Boolean);
Object.assign(out, { pass, checks, ring, moved, tipsToCloser, before, after, reputation: rep });
writeFileSync(join(ROOT, 'docs', 'measurements', 'rings-multiwallet.json'), JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
log(pass ? 'rings-multiwallet PASS' : `rings-multiwallet FAIL ${JSON.stringify(checks)}`);
process.exit(pass ? 0 : 1);
