// K1: three funded agents settle a 3-ring in ONE execute_intents on our testnet Verifier;
// all three balances change in one receipt.
import { intentHash } from '../packages/intents/src/index.js';
import { balances, client, CONFIG, explorer, fundAgents, implicitAgent, legFor, log, parent, ringDiffs, saveResult, T } from './k-lib.js';

const X = 1_000_000n;
const toks = [T.wNEAR!.id, T.USDC!.id, T.USDT!.id];
const agents = [implicitAgent(), implicitAgent(), implicitAgent()];
const fee = await client.fee();
const diffs = ringDiffs(3, X, fee, toks);

const funding = await fundAgents(agents.map((a, i) => ({ to: a.id, tokens: { [toks[i]!]: X } })));
const before = await balances([...agents.map((a) => a.id), CONFIG.feeCollector], toks);
const signed = await Promise.all(agents.map((a, i) => legFor(a, diffs[i]!, { memo: 'nomad-k1' })));
const sim = await client.simulate(signed);
log('simulate ok=', sim.ok, sim.error ?? '', 'executed=', sim.intentsExecuted?.length);
const ex = await client.execute(signed, parent);
log('execute', ex.txHash, 'ok=', ex.ok, ex.error ?? '', 'gas=', ex.gasBurnt, 'blocks', ex.blockHeight, ex.receiptBlockHeights);
const after = await balances([...agents.map((a) => a.id), CONFIG.feeCollector], toks);

// which receipts carried the balance changes: the execute_intents receipt logs the mt_transfer / token_diff events
const tokenDiffEvents = ex.logs.filter((l) => l.includes('"token_diff"'));
const ourHashes = signed.map(intentHash);
const loggedHashes = tokenDiffEvents.map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)).data[0].intent_hash);
const feesCollected = toks.map((t) => BigInt(after[CONFIG.feeCollector]![t]!) - BigInt(before[CONFIG.feeCollector]![t]!));
const pass =
  ex.ok &&
  ex.receiptBlockHeights.length === 1 && // one receipt carried every balance change
  agents.every((a, i) => after[a.id]![toks[i]!] === '0' && after[a.id]![toks[(i + 1) % 3]!] === (X - 1n).toString()) &&
  tokenDiffEvents.length === 3 &&
  ourHashes.every((h, i) => h === loggedHashes[i]) &&
  feesCollected.every((f) => f === 1n);
saveResult('k1-ring3', {
  pass,
  fundingTx: funding.txHash,
  tx: ex.txHash,
  explorer: explorer(ex.txHash),
  gasBurnt: ex.gasBurnt,
  agents: agents.map((a) => a.id),
  diffs,
  simulate: { ok: sim.ok, intentsExecuted: sim.intentsExecuted?.length },
  before,
  after,
  tokenDiffEventLogs: tokenDiffEvents.length,
  receipts: ex.receiptBlockHeights.length,
  intentHashesMatch: ourHashes.every((h, i) => h === loggedHashes[i]),
  feesCollected,
  logs: ex.logs,
});
log(pass ? 'K1 PASS' : 'K1 FAIL');
