// K-a: one ring mixing three wallet standards settles in ONE execute_intents on our testnet Verifier.
//   leg 1  a01.nomadswarm.testnet          nep413       (named NEAR account, key registered on the Verifier)
//   leg 2  0x… (fresh secp256k1 key)       erc191       (Ethereum personal_sign; implicit 0x account)
//   leg 3  <hex> (fresh ed25519 key)       raw_ed25519  (Solana/Phantom signMessage; implicit hex account)
// Sizing: each gives x and receives x − ceil(x·fee/1e6) (BUILD_PLAN C1), so every token nets to zero
// with nothing left over. Submitted by intents-matcher.nomadswarm.testnet.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  anyIntentHash,
  ethAddressOf,
  hexencode,
  intentHash,
  rawEd25519AccountId,
  signErc191TokenDiff,
  signRawEd25519TokenDiff,
  signTokenDiff,
  signerFor,
  verifyAnyPayload,
  verifyPayload,
  type MultiPayload,
} from '../packages/intents/src/index.js';
import { CONFIG, PARENT, ROOT, T, balances, client, contractOf, explorer, log, ringDiffs, saveResult } from './k-lib.js';

const X = 1_000_000n; // 1 USDC, 1 USDT, 0.01 ZEC (testnet tokens)
const toks = [T.USDC!.id, T.USDT!.id, T.ZEC!.id];
const MATCHER = 'intents-matcher.nomadswarm.testnet';

// Fresh wallet keys; kept in keys/ (gitignored) so the accounts can be inspected or reused. Never committed.
const keysDir = join(ROOT, 'keys');
mkdirSync(keysDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const ethKey = new Uint8Array(randomBytes(32));
const solSeed = new Uint8Array(randomBytes(32));
const a01Key = JSON.parse(readFileSync(join(keysDir, 'a01.nomadswarm.testnet.intents.json'), 'utf8')) as { account_id: string; public_key: string; private_key: string };

const wallets = [
  { id: a01Key.account_id, standard: 'nep413' as const },
  { id: ethAddressOf(ethKey), standard: 'erc191' as const },
  { id: rawEd25519AccountId(solSeed), standard: 'raw_ed25519' as const },
];
const keyFile = join(keysDir, `k-a-${runId}.json`);
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, JSON.stringify({ erc191: { account_id: wallets[1]!.id, private_key_hex: hexencode(ethKey) }, raw_ed25519: { account_id: wallets[2]!.id, seed_hex: hexencode(solSeed) } }, null, 2));
}
log('wallets', wallets.map((w) => `${w.standard}=${w.id}`).join('  '));

// a01 must still have its key on the Verifier.
const a01Registered = await client.hasPublicKey(a01Key.account_id, a01Key.public_key);
if (!a01Registered) throw new Error('a01 intents key is not registered on the Verifier');

// Fund each wallet with exactly what it gives: ft_transfer_call from the token owner, msg = receiver.
const funder = signerFor(PARENT);
const fundingTxs: { to: string; token: string; tx: string; ok: boolean }[] = [];
for (const [i, w] of wallets.entries()) {
  const r = await client.deposit(funder, contractOf(toks[i]!), X, w.id);
  log(`deposit ${X} ${toks[i]} -> ${w.id}: ${r.txHash} ok=${r.ok}${r.error ? ' ' + r.error : ''}`);
  fundingTxs.push({ to: w.id, token: toks[i]!, tx: r.txHash, ok: r.ok });
  if (!r.ok) throw new Error('funding failed');
}

const fee = await client.fee();
const diffs = ringDiffs(3, X, fee, toks); // wallet i: −X of toks[i], +(X − fee) of toks[i+1]
const str = (d: Record<string, bigint>) => Object.fromEntries(Object.entries(d).map(([t, a]) => [t, a.toString()]));
const salt = await client.currentSalt();
const deadline = new Date(Date.now() + 120_000);
const memo = 'nomad-k-a';

const legNep413 = signTokenDiff({ signerId: a01Key.account_id, secretKey: a01Key.private_key, verifierId: CONFIG.verifierId, salt, deadline, diff: str(diffs[0]!), memo });
const legErc191 = signErc191TokenDiff({ privateKey: ethKey, verifierId: CONFIG.verifierId, salt, deadline, diff: str(diffs[1]!), memo });
const legRaw = signRawEd25519TokenDiff({ seed: solSeed, verifierId: CONFIG.verifierId, salt, deadline, diff: str(diffs[2]!), memo });
const localOk = [verifyPayload(legNep413), verifyAnyPayload(legErc191), verifyAnyPayload(legRaw)];
log('local signature checks', localOk);

const signed = [legNep413, legErc191, legRaw] as unknown as MultiPayload[];
const ourHashes = [intentHash(legNep413), anyIntentHash(legErc191), anyIntentHash(legRaw)];
const watch = [...wallets.map((w) => w.id), CONFIG.feeCollector];
const before = await balances(watch, toks);

const sim = await client.simulate(signed);
log('simulate ok=', sim.ok, sim.error ?? '', 'executed=', sim.intentsExecuted?.length);
if (!sim.ok) {
  saveResult('k-a-multiwallet', { pass: false, stage: 'simulate', error: sim.error, errorClass: sim.errorClass, wallets, diffs, fundingTxs, payloads: signed });
  log('K-a FAIL (simulate)');
  process.exit(1);
}

const ex = await client.execute(signed, signerFor(MATCHER));
log('execute', ex.txHash, 'ok=', ex.ok, ex.error ?? '', 'gas=', ex.gasBurnt, 'blocks', ex.blockHeight, ex.receiptBlockHeights);
const after = await balances(watch, toks);

const events = ex.logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)));
const tokenDiff = events.filter((e) => e.standard === 'dip4' && e.event === 'token_diff').flatMap((e) => e.data as { intent_hash: string; account_id: string }[]);
const executed = events.filter((e) => e.standard === 'dip4' && e.event === 'intents_executed').flatMap((e) => e.data as { intent_hash: string; account_id: string }[]);

const moved = wallets.map((w, i) => ({
  account: w.id,
  standard: w.standard,
  gave: BigInt(before[w.id]![toks[i]!]!) - BigInt(after[w.id]![toks[i]!]!),
  got: BigInt(after[w.id]![toks[(i + 1) % 3]!]!) - BigInt(before[w.id]![toks[(i + 1) % 3]!]!),
}));
const feeTaken = toks.map((t) => BigInt(after[CONFIG.feeCollector]![t]!) - BigInt(before[CONFIG.feeCollector]![t]!));
const hashesLogged = wallets.map((w) => tokenDiff.find((d) => d.account_id === w.id)?.intent_hash ?? null);
const checks = {
  localSignatures: localOk.every(Boolean),
  simulateExecuted3: sim.intentsExecuted?.length === 3,
  txOk: ex.ok,
  oneReceipt: ex.receiptBlockHeights.length === 1,
  eachGaveX: moved.every((m) => m.gave === X),
  eachGotXMinusFee: moved.every((m) => m.got === X - (X * BigInt(fee) + 999_999n) / 1_000_000n),
  feeCollectorGotFee: feeTaken.every((f) => f === (X * BigInt(fee) + 999_999n) / 1_000_000n),
  intentHashesMatch: hashesLogged.every((h, i) => h === ourHashes[i]),
  allThreeExecuted: wallets.every((w) => executed.some((e) => e.account_id === w.id)),
};
const pass = Object.values(checks).every(Boolean);

saveResult('k-a-multiwallet', {
  pass,
  checks,
  tx: ex.txHash,
  explorer: explorer(ex.txHash),
  submitter: MATCHER,
  blockHeight: ex.blockHeight,
  receiptBlockHeights: ex.receiptBlockHeights,
  gasBurnt: ex.gasBurnt,
  feePips: fee,
  x: X,
  tokens: toks,
  wallets: wallets.map((w, i) => ({ ...w, intentHash: ourHashes[i], loggedIntentHash: hashesLogged[i] })),
  diffs,
  fundingTxs,
  moved,
  feeTaken,
  before,
  after,
  payloads: signed,
  logs: ex.logs,
});
log(pass ? 'K-a PASS' : `K-a FAIL ${JSON.stringify(checks)}`);
if (!pass) process.exit(1);
