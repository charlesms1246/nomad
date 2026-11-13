// K6: deposit formats. ft_transfer_call(receiver_id = verifier, amount, msg) with 1 yocto:
//   msg ""                       -> credits the sender
//   msg "<account id>"           -> credits that account
//   msg '{"receiver_id":"<id>"}' -> credits that account (JSON form)
//   msg "not a valid id!"        -> ft_on_transfer panics, the token refunds the sender
// plus the real wNEAR path: wrap.testnet near_deposit, then ft_transfer_call.
import { ONE_NEAR, TGAS } from '../packages/intents/src/index.js';
import { client, CONFIG, explorer, implicitAgent, log, parent, PARENT, rpc, saveResult, T } from './k-lib.js';

const U = T.USDC!;
const tok = U.contract, id = U.id;
const rows: any[] = [];
async function dep(name: string, msg: string, creditTo: string, amount = 1234n, token = tok, tokenId = id) {
  const ftBefore = await client.ftBalanceOf(token, PARENT);
  const mtBefore = await client.mtBalanceOf(creditTo, tokenId);
  const r = await rpc.sendTx(parent, token, [
    { type: 'FunctionCall', methodName: 'ft_transfer_call', args: { receiver_id: CONFIG.verifierId, amount: amount.toString(), msg }, gas: 100n * TGAS, deposit: 1n },
  ]);
  const ftAfter = await client.ftBalanceOf(token, PARENT);
  const mtAfter = await client.mtBalanceOf(creditTo, tokenId);
  const failedReceipt = r.raw.receipts_outcome.find((o: any) => o.outcome.status?.Failure);
  const row = {
    name, msg, creditTo, amount, tx: r.txHash, explorer: explorer(r.txHash), txOk: r.ok, returnValue: r.returnValue,
    credited: mtAfter - mtBefore, senderFtDelta: ftAfter - ftBefore,
    innerError: failedReceipt ? JSON.stringify(failedReceipt.outcome.status.Failure).slice(0, 200) : undefined,
  };
  log(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  rows.push(row);
  return row;
}
const a = implicitAgent(), b = implicitAgent();
const r1 = await dep('empty msg credits sender', '', PARENT);
const r2 = await dep('account id msg credits that account', a.id, a.id);
const r3 = await dep('JSON receiver_id msg', JSON.stringify({ receiver_id: b.id }), b.id);
const r4 = await dep('invalid msg panics and is refunded', 'not a valid id!', PARENT);
const r5 = await dep('named sub-account that does not exist on chain', 'ghost.nomadswarm.testnet', 'ghost.nomadswarm.testnet');

// wNEAR: wrap 0.01 NEAR on wrap.testnet, then deposit it for agent a
const wrapAmt = ONE_NEAR / 100n;
const w = await client.nearDeposit(parent, 'wrap.testnet', wrapAmt);
log('near_deposit', w.txHash, w.ok);
const r6 = await dep('wrap.testnet after near_deposit', a.id, a.id, wrapAmt, 'wrap.testnet', 'nep141:wrap.testnet');

const pass =
  r1.credited === 1234n && r2.credited === 1234n && r3.credited === 1234n &&
  r4.credited === 0n && r4.senderFtDelta === 0n &&
  r5.credited === 1234n && r6.credited === wrapAmt;
saveResult('k6-deposit', { pass, nearDepositTx: w.txHash, rows });
log(pass ? 'K6 PASS' : 'K6 FAIL');
