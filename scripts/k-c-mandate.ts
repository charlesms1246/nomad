// K-c: can a contract-held mandate sign intents through NEAR chain signatures?
//  (1) mandate.<parent>'s cross-contract call to v1.signer-prod.testnet `sign` returns a secp256k1 signature;
//  (2) the resulting erc191 MultiPayload, for signer_id = the MPC-derived 0x address, passes
//      intents.nomadswarm.testnet `simulate_intents` (paired with a NEP-413 counterpart leg so the ring closes).
// Testnet only. Run: node --dns-result-order=ipv4first --import tsx scripts/k-c-mandate.ts
import { CONFIG, PARENT, T, client, ensureFunder, explorer, legFor, log, parent, ringDiffs } from './k-lib.js';
import { MANDATE_ID, derivedAddress, ensureDeployed, makeLeg, nextLegId, requestLeg, saveSection, setMandate, waitSigned } from './mandate-lib.js';

const USDC = T.USDC!.id, USDT = T.USDT!.id;
const X = 100_000n; // 0.1 USDC

const deploy = await ensureDeployed();
const { address, publicKey } = await derivedAddress(PARENT);
log(`derived for path mandate/${PARENT} predecessor ${MANDATE_ID}: ${publicKey} -> ${address}`);

// Fund the 0x account inside the Verifier with a little USDC (msg = the 0x address).
let fundTx: string | undefined;
if ((await client.mtBalanceOf(address, USDC)) < X) {
  const r = await client.deposit(parent, T.USDC!.contract, 1_000_000n, address);
  fundTx = r.txHash;
  log(`fund ${address} 1 USDC: ${r.txHash} ok=${r.ok} ${r.error ?? ''}`);
  if (!r.ok) throw new Error('funding failed');
}
const bal = await client.mtBalanceOf(address, USDC);
log(`${address} USDC in Verifier: ${bal}`);

const set = await setMandate(parent, {
  eth_address: address,
  tokens: [
    { token: USDC, max_per_leg: '1000000', daily_budget: '3000000' },
    { token: USDT, max_per_leg: '1000000', daily_budget: '3000000' },
  ],
  prices: [
    { give: USDC, want: USDT, rate_num: '99', rate_den: '100' },
    { give: USDT, want: USDC, rate_num: '99', rate_den: '100' },
  ],
  min_counterparty_reputation: 0,
  expires_at_ms: Date.now() + 30 * 24 * 3600_000,
});
if (!set.ok) throw new Error('set_mandate failed');

const fee = await client.fee();
const [dMandate, dParent] = ringDiffs(2, X, fee, [USDC, USDT]) as [Record<string, bigint>, Record<string, bigint>];
const leg = await makeLeg({ owner: PARENT, give: USDC, give_amount: X.toString(), get: USDT, get_amount: dMandate[USDT]!.toString() });
const id = await nextLegId();
const req = await requestLeg(parent, leg);
const signed = await waitSigned(id);
log(`signed_leg(${id}): status=${signed?.status} sig=${signed?.multi_payload?.signature} err=${signed?.error ?? ''}`);
const mpcOk = signed?.status === 'Signed';

let sim: any = null, simAlone: any = null;
if (mpcOk) {
  await ensureFunder({ [USDT]: X * 2n });
  const counter = await legFor({ id: PARENT, secretKey: parent.secretKey }, dParent, { salt: leg.salt, deadline: new Date(leg.deadline_ms) });
  sim = await client.simulate([signed.multi_payload as any, counter]);
  log(`simulate_intents [erc191 mandate leg, nep413 counterpart]: ok=${sim.ok} ${sim.error ?? ''}`);
  log(JSON.stringify(sim.intentsExecuted));
  simAlone = await client.simulate([signed.multi_payload as any]);
  log(`simulate_intents [erc191 leg alone]: ok=${simAlone.ok} ${simAlone.error ?? ''}`);
}

const pass = mpcOk && sim?.ok === true && sim.intentsExecuted?.some((e: any) => e.account_id === address);
log(`K-c ${pass ? 'PASS' : 'FAIL'}`);
saveSection('kc', {
  pass,
  derived: { owner: PARENT, path: `mandate/${PARENT}`, predecessor: MANDATE_ID, publicKey, address },
  txs: {
    deploy: deploy?.txHash,
    fund: fundTx,
    setMandate: set.txHash,
    requestLegSignature: req.txHash,
    requestLegExplorer: explorer(req.txHash),
  },
  requestLatencyMs: req.ms,
  requestGasBurnt: req.gasBurnt,
  receiptBlockHeights: req.receiptBlockHeights,
  leg: { id, ...leg },
  signedLeg: signed,
  simulate: sim && { ok: sim.ok, error: sim.error, intentsExecuted: sim.intentsExecuted, logs: sim.logs },
  simulateAlone: simAlone && { ok: simAlone.ok, error: simAlone.error, errorClass: simAlone.errorClass },
  verifier: CONFIG.verifierId,
});
