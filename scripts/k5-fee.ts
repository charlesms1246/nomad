// K5: how the 1-pip fee shows up. Compares a naive zero-sum swap (A:-x/B:+x) with the fee-correct
// one (B gets x − ceil(x·fee/1e6)), checks the reported unmatched deltas against our closureDeltas(),
// checks rounding at fee boundaries, and that a positive-only (matcher) leg pays no fee.
import { closureDeltas, feeOf } from '../packages/intents/src/index.js';
import { balances, client, CONFIG, explorer, fundAgents, implicitAgent, legFor, log, parent, saveResult, T } from './k-lib.js';

const fee = await client.fee();
const W = T.wNEAR!.id, U = T.USDC!.id;
const cases: any[] = [];

async function swapCase(name: string, x: bigint, y: bigint, opts: { execute?: boolean; matcher?: bigint } = {}) {
  const A = implicitAgent(), B = implicitAgent(), M = implicitAgent();
  await fundAgents([{ to: A.id, tokens: { [W]: x } }, { to: B.id, tokens: { [U]: x } }]);
  // A gives x W, gets y U; B gives x U, gets y W (− matcher cut in W)
  const m = opts.matcher ?? 0n;
  const dA = { [W]: -x, [U]: y }, dB = { [U]: -x, [W]: y - m };
  const legs = [await legFor(A, dA), await legFor(B, dB)];
  if (m > 0n) legs.push(await legFor(M, { [W]: m }));
  const sim = await client.simulate(legs);
  const predicted = closureDeltas([dA, dB, ...(m > 0n ? [{ [W]: m }] : [])], fee);
  const c: any = { name, x, y, matcher: m, feeOfX: feeOf(x, fee), ok: sim.ok, errorClass: sim.errorClass, unmatched: (sim.invariantViolated as any)?.unmatched_deltas, closurePredicted: predicted };
  if (opts.execute && sim.ok) {
    const before = await balances([CONFIG.feeCollector, M.id], [W, U]);
    const ex = await client.execute(legs, parent);
    const after = await balances([CONFIG.feeCollector, M.id], [W, U]);
    c.tx = ex.txHash;
    c.explorer = explorer(ex.txHash);
    c.feeCollectorDelta = { [W]: BigInt(after[CONFIG.feeCollector]![W]!) - BigInt(before[CONFIG.feeCollector]![W]!), [U]: BigInt(after[CONFIG.feeCollector]![U]!) - BigInt(before[CONFIG.feeCollector]![U]!) };
    c.matcherGot = after[M.id]![W];
    c.feesCollectedLogs = ex.logs.filter((l) => l.includes('fees_collected')).map((l) => JSON.parse(l.slice(11)).data[0].fees_collected);
  }
  log(JSON.stringify(c, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  cases.push(c);
  return c;
}

const naive = await swapCase('naive zero-sum (A:-x, B:+x)', 1000n, 1000n);
const correct = await swapCase('fee-correct (receiver gets x − ceil(x·fee/1e6))', 1000n, 999n, { execute: true });
const over = await swapCase('receiver asks one unit too much', 1000n, 1000n - feeOf(1000n, fee) + 1n);
const boundary1 = await swapCase('x = 1e6 (fee exactly 1)', 1_000_000n, 999_999n);
const boundary2 = await swapCase('x = 1e6 + 1 (fee rounds up to 2)', 1_000_001n, 999_999n);
const boundary2wrong = await swapCase('x = 1e6 + 1 with fee 1 assumed', 1_000_001n, 1_000_000n);
const withMatcher = await swapCase('matcher positive-only leg takes 7 W (fee-free)', 1000n, 999n, { execute: true, matcher: 7n });
const dust = await swapCase('x = 1: fee 1 leaves 0 to receive -> zero amount', 1n, 0n).catch((e) => ({ name: 'x=1', error: String(e.message) }));

// closure: what a third signer would have to add to make the naive swap pass (defuse closure_deltas)
const C = implicitAgent();
const cl = closureDeltas([{ [W]: -1000n, [U]: 1000n }, { [U]: -1000n, [W]: 1000n }], fee);
await fundAgents([{ to: C.id, tokens: Object.fromEntries(Object.entries(cl).filter(([, v]) => v < 0n).map(([k, v]) => [k, -v])) }]);
const A2 = implicitAgent(), B2 = implicitAgent();
await fundAgents([{ to: A2.id, tokens: { [W]: 1000n } }, { to: B2.id, tokens: { [U]: 1000n } }]);
const closureFixes = await client.simulate([await legFor(A2, { [W]: -1000n, [U]: 1000n }), await legFor(B2, { [U]: -1000n, [W]: 1000n }), await legFor(C, cl)]);
log('closure', JSON.stringify(cl, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), 'fixes naive swap:', closureFixes.ok, closureFixes.error ?? '');
const unm = (c: any) => c.unmatched && Object.fromEntries(Object.entries(c.unmatched).map(([k, v]) => [k, BigInt(v as string)]));
const pass =
  !naive.ok &&
  correct.ok &&
  !over.ok &&
  boundary1.ok &&
  boundary2.ok &&
  !boundary2wrong.ok &&
  withMatcher.ok &&
  correct.feeCollectorDelta[T.wNEAR!.id] === 1n &&
  correct.feeCollectorDelta[T.USDC!.id] === 1n &&
  withMatcher.matcherGot === '7' &&
  // the Verifier's unmatched deltas are the net sum of all deltas plus collected fees
  unm(naive)?.[W] === 1n && unm(naive)?.[U] === 1n &&
  closureFixes.ok;
saveResult('k5-fee', { pass, feePips: fee, closure: { deltas: cl, ok: closureFixes.ok, error: closureFixes.error }, rule: 'fee = ceil(|d|*fee/1e6) on each negative delta; positives pay none; receiver gets x - fee(x)', cases, dust });
log(pass ? 'K5 PASS' : 'K5 FAIL');
