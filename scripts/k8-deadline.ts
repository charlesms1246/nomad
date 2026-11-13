// K8: deadlines, salts and nonces on our Verifier.
//  - far-future deadlines (no maximum), message deadline > nonce deadline, expired deadline
//  - salt rotation: a leg signed with salt S1 still passes after update_current_salt (S2),
//    and fails with `invalid salt` only after invalidate_salts([S1]). (We never invalidate the
//    salt other sessions use: S0 stays valid.)
//  - legacy random 32-byte nonce, nonce replay
import { randomBytes } from 'node:crypto';
import { TGAS, buildNonce } from '../packages/intents/src/index.js';
import { client, CONFIG, explorer, fundAgents, implicitAgent, legFor, log, parent, PARENT, rpc, saveResult, T } from './k-lib.js';

const W = T.wNEAR!.id, U = T.USDC!.id;
const A = implicitAgent(), B = implicitAgent();
await fundAgents([{ to: A.id, tokens: { [W]: 100_000n } }, { to: B.id, tokens: { [U]: 100_000n } }]);
const pair = async (opts: { deadline?: Date; salt?: string; nonceA?: Uint8Array } = {}) => [
  await legFor(A, { [W]: -1000n, [U]: 999n }, { ...opts, nonce: opts.nonceA }),
  await legFor(B, { [U]: -1000n, [W]: 999n }, opts),
];
const out: any = {};
const S0 = await client.currentSalt(0);

// deadlines
const far = new Date('2200-01-01T00:00:00Z');
out.deadline2200 = await client.simulate(await pair({ deadline: far }));
const nearMax = new Date(Number((2n ** 63n - 1n) / 1_000_000n) - 1000); // just under the i64-ns limit (year 2262)
out.deadlineNearI64Max = await client.simulate(await pair({ deadline: nearMax }));
const dl = new Date(Date.now() + 120_000);
out.messageDeadlineAfterNonce = await client.simulate(await pair({ deadline: dl, nonceA: buildNonce(S0, new Date(dl.getTime() - 60_000)) }));
out.expired = await client.simulate(await pair({ deadline: new Date(Date.now() - 1000) }));
out.legacyRandomNonce = await client.simulate(await pair({ nonceA: new Uint8Array(randomBytes(32)) }));
out.zeroSalt = await client.simulate(await pair({ salt: '00000000' }));

// salt rotation (we are super-admin; grant ourselves SaltManager first)
const hasRole = await rpc.view<boolean>(CONFIG.verifierId, 'acl_has_role', { role: 'SaltManager', account_id: PARENT });
if (!hasRole) {
  const g = await rpc.sendTx(parent, CONFIG.verifierId, [{ type: 'FunctionCall', methodName: 'acl_grant_role', args: { role: 'SaltManager', account_id: PARENT }, gas: 10n * TGAS, deposit: 0n }]);
  log('grant SaltManager', g.txHash, g.ok, g.error ?? g.returnValue);
}
const rot1 = await rpc.sendTx(parent, CONFIG.verifierId, [{ type: 'FunctionCall', methodName: 'update_current_salt', args: {}, gas: 10n * TGAS, deposit: 1n }]);
const S1 = JSON.parse(rot1.returnValue!);
const legsS1 = await pair({ salt: S1 });
const rot2 = await rpc.sendTx(parent, CONFIG.verifierId, [{ type: 'FunctionCall', methodName: 'update_current_salt', args: {}, gas: 10n * TGAS, deposit: 1n }]);
const S2 = JSON.parse(rot2.returnValue!);
out.oldSaltAfterRotation = await client.simulate(legsS1);
const inv = await rpc.sendTx(parent, CONFIG.verifierId, [{ type: 'FunctionCall', methodName: 'invalidate_salts', args: { salts: [S1] }, gas: 10n * TGAS, deposit: 1n }]);
out.oldSaltAfterInvalidate = await client.simulate(legsS1);
out.s0StillValid = await client.isValidSalt(S0);

// replay
const legs = await pair();
const ex1 = await client.execute(legs, parent);
const ex2 = await client.execute(legs, parent);
out.replay = { first: { tx: ex1.txHash, ok: ex1.ok }, second: { tx: ex2.txHash, ok: ex2.ok, error: ex2.error } };

const brief = (r: any) => (r && 'ok' in r && 'errorClass' in r ? { ok: r.ok, error: r.error } : r);
const res = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, brief(v)]));
log(JSON.stringify(res, null, 1));
const pass =
  out.deadline2200.ok && out.deadlineNearI64Max.ok && !out.messageDeadlineAfterNonce.ok && !out.expired.ok &&
  out.legacyRandomNonce.ok && !out.zeroSalt.ok && out.oldSaltAfterRotation.ok && !out.oldSaltAfterInvalidate.ok &&
  out.oldSaltAfterInvalidate.errorClass === 'invalid salt' && out.s0StillValid && ex1.ok && !ex2.ok;
saveResult('k8-deadline', {
  pass, salts: { S0, S1, S2 },
  rotationTxs: { update1: rot1.txHash, update2: rot2.txHash, invalidate: inv.txHash, invalidateOk: inv.ok },
  replayExplorer: explorer(ex2.txHash), results: res,
});
log(pass ? 'K8 PASS' : 'K8 FAIL');
