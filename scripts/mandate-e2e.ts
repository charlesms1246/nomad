// End-to-end on testnet: set a mandate, request a leg signature (with a matcher tip), check the
// Verifier accepts the signed erc191 leg in simulate_intents (then settle it with execute_intents),
// and show two requests the mandate refuses: below the min price, and over the daily budget.
// Run: cd apps/matcher && pnpm exec tsx ../../scripts/mandate-e2e.ts   (NODE_OPTIONS=--dns-result-order=ipv4first)
import { CONFIG, PARENT, T, client, ensureFunder, explorer, legFor, log, parent, rpc } from './k-lib.js';
import { MANDATE_ID, derivedAddress, ensureDeployed, makeLeg, nextLegId, requestLeg, saveSection, setMandate, waitSigned } from './mandate-lib.js';

const USDC = T.USDC!.id, USDT = T.USDT!.id;
const MATCHER = `matcher.${PARENT}`;
const EXECUTE = process.env.EXECUTE !== '0';

await ensureDeployed();
const { address } = await derivedAddress(PARENT);
log(`agent ${PARENT} -> signer_id ${address}`);
if ((await client.mtBalanceOf(address, USDC)) < 500_000n) {
  const r = await client.deposit(parent, T.USDC!.contract, 1_000_000n, address);
  log(`fund ${address}: ${r.txHash} ok=${r.ok}`);
}

const spent = BigInt(await rpc.view<string>(MANDATE_ID, 'spent_today', { owner: PARENT, token: USDC }));
const budget = spent + 300_000n;
const set = await setMandate(parent, {
  eth_address: address,
  tokens: [
    { token: USDC, max_per_leg: '200000', daily_budget: budget.toString() },
    { token: USDT, max_per_leg: '200000', daily_budget: '1000000' },
  ],
  prices: [{ give: USDC, want: USDT, rate_num: '99', rate_den: '100' }],
  min_counterparty_reputation: 50,
  expires_at_ms: Date.now() + 7 * 24 * 3600_000,
});
log(`mandate: USDC max/leg 200000, budget today ${budget} (spent ${spent}), min price USDC->USDT 0.99`);

// 1. A good leg: give 150000 USDC, get 149999 USDT, tip 100 USDC to the matcher.
const X = 150_000n, TIP = 100n;
const fee = await client.fee();
const net = X - (X * BigInt(fee) + 999_999n) / 1_000_000n;
const leg = await makeLeg({
  owner: PARENT, give: USDC, give_amount: X.toString(), get: USDT, get_amount: net.toString(),
  tip: { token: USDC, amount: TIP.toString(), receiver_id: MATCHER },
});
const id = await nextLegId();
const req = await requestLeg(parent, leg);
const signed = await waitSigned(id);
log(`signed_leg(${id}) ${signed.status} ${signed.multi_payload?.signature ?? signed.error}`);

await ensureFunder({ [USDT]: X * 2n });
const counter = await legFor({ id: PARENT, secretKey: parent.secretKey }, { [USDC]: net, [USDT]: -X }, { salt: leg.salt, deadline: new Date(leg.deadline_ms) });
const batch = [signed.multi_payload, counter] as any[];
const sim = await client.simulate(batch);
log(`simulate_intents: ok=${sim.ok} ${sim.error ?? ''} executed=${JSON.stringify(sim.intentsExecuted?.map((e) => e.account_id))}`);

let exec: any = null;
if (EXECUTE && sim.ok) {
  const before = await client.mtBatchBalanceOf(address, [USDC, USDT]);
  const r = await client.execute(batch, parent);
  const after = await client.mtBatchBalanceOf(address, [USDC, USDT]);
  exec = { tx: r.txHash, explorer: explorer(r.txHash), ok: r.ok, error: r.error, gasBurnt: r.gasBurnt, agentDelta: { [USDC]: (after[0]! - before[0]!).toString(), [USDT]: (after[1]! - before[1]!).toString() } };
  log(`execute_intents ${r.txHash} ok=${r.ok} agent delta ${JSON.stringify(exec.agentDelta)}`);
}

// 2. Rejected: below the minimum price (0.90 < 0.99).
const cheap = await makeLeg({ owner: PARENT, give: USDC, give_amount: '100000', get: USDT, get_amount: '90000' });
const cheapWhy = await rpc.view<string | null>(MANDATE_ID, 'check_leg', { leg: cheap });
const cheapReq = await requestLeg(parent, cheap);

// 3. Rejected: over the daily budget (150100 already used of 300000 headroom; 160000 more is too much).
const big = await makeLeg({ owner: PARENT, give: USDC, give_amount: '160000', get: USDT, get_amount: '159000' });
const bigWhy = await rpc.view<string | null>(MANDATE_ID, 'check_leg', { leg: big });
const bigReq = await requestLeg(parent, big);

const pass = signed.status === 'Signed' && sim.ok && !cheapReq.ok && !bigReq.ok && (!exec || exec.ok);
log(`E2E ${pass ? 'PASS' : 'FAIL'}; rejected: [${cheapReq.error}] [${bigReq.error}]`);
saveSection('e2e', {
  pass,
  owner: PARENT,
  signerId: address,
  mandateSetTx: set.txHash,
  accepted: {
    tx: req.txHash, explorer: explorer(req.txHash), latencyMs: req.ms, gasBurnt: req.gasBurnt, receiptBlockHeights: req.receiptBlockHeights,
    leg: { id, ...leg }, multiPayload: signed.multi_payload,
    simulate: { ok: sim.ok, error: sim.error, intentsExecuted: sim.intentsExecuted },
    execute: exec,
  },
  rejectedBelowMinPrice: { tx: cheapReq.txHash, explorer: explorer(cheapReq.txHash), ok: cheapReq.ok, error: cheapReq.error, checkLegView: cheapWhy, leg: cheap },
  rejectedOverBudget: { tx: bigReq.txHash, explorer: explorer(bigReq.txHash), ok: bigReq.ok, error: bigReq.error, checkLegView: bigWhy, leg: big },
  verifier: CONFIG.verifierId,
});
