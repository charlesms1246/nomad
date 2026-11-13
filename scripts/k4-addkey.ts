// K4: a named sub-account registers an intents key with add_public_key (1 yocto) on our Verifier,
// and a leg signed with that key then passes simulate and settles. Also checks that the account's
// own NEAR full-access key does NOT count until registered (BUILD_PLAN C7), and the 1-yocto rule.
import {
  ONE_NEAR, TGAS, hasCredentials, loadCredentials, randomKeyPair, saveCredentials, signTokenDiff,
} from '../packages/intents/src/index.js';
import { client, CONFIG, explorer, fundAgents, implicitAgent, legFor, log, parent, PARENT, rpc, saveResult, T } from './k-lib.js';

const ID = `k4.${PARENT}`;
const W = T.wNEAR!.id, U = T.USDC!.id;
let createTx: string | undefined;
if (!(await rpc.viewAccount(ID))) {
  const kp = randomKeyPair();
  if (hasCredentials(ID)) throw new Error(`stale credentials for ${ID}`);
  saveCredentials({ account_id: ID, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
  const r = await rpc.sendTx(parent, ID, [
    { type: 'CreateAccount' },
    { type: 'Transfer', deposit: ONE_NEAR / 10n },
    { type: 'AddKey', publicKey: kp.publicKeyStr, permission: 'FullAccess' },
  ]);
  createTx = r.txHash;
  log('created', ID, r.txHash, r.ok);
}
const acct = loadCredentials(ID);
const me = { signerId: ID, secretKey: acct.private_key };
const intentsKey = randomKeyPair();
const cp = implicitAgent();
await fundAgents([{ to: ID, tokens: { [W]: 1000n } }, { to: cp.id, tokens: { [U]: 1000n } }]);

const salt = await client.currentSalt();
const deadline = new Date(Date.now() + 120_000);
const legWith = (secretKey: string) =>
  signTokenDiff({ signerId: ID, secretKey, verifierId: CONFIG.verifierId, salt, deadline, diff: { [W]: '-1000', [U]: '999' } });
const cpLeg = await legFor(cp, { [U]: -1000n, [W]: 999n });

const before = await client.simulate([legWith(intentsKey.secretKeyStr), cpLeg]);
const nearKeyOnly = await client.simulate([legWith(acct.private_key), cpLeg]);
log('before add_public_key:', before.errorClass, '| NEAR full-access key, unregistered:', nearKeyOnly.errorClass);

// 0 deposit must fail (assert_one_yocto)
const noYocto = await rpc.sendTx(me, CONFIG.verifierId, [
  { type: 'FunctionCall', methodName: 'add_public_key', args: { public_key: intentsKey.publicKeyStr }, gas: 10n * TGAS, deposit: 0n },
]);
log('add_public_key with 0 deposit:', noYocto.ok, noYocto.error);
const add = await client.addPublicKey(me, intentsKey.publicKeyStr);
log('add_public_key:', add.txHash, add.ok, add.logs);
const registered = await client.hasPublicKey(ID, intentsKey.publicKeyStr);
const leg = legWith(intentsKey.secretKeyStr);
const after = await client.simulate([leg, cpLeg]);
const ex = after.ok ? await client.execute([leg, cpLeg], parent) : undefined;
log('after:', after.ok, after.errorClass ?? '', 'execute', ex?.txHash, ex?.ok);
const pass = !before.ok && before.errorClass === 'public key not registered' && !nearKeyOnly.ok && !noYocto.ok && add.ok && registered && after.ok && !!ex?.ok;
saveResult('k4-addkey', {
  pass, account: ID, createTx, intentsPublicKey: intentsKey.publicKeyStr,
  beforeRegistration: { ok: before.ok, error: before.error },
  nearFullAccessKeyUnregistered: { ok: nearKeyOnly.ok, error: nearKeyOnly.error },
  addPublicKeyZeroDeposit: { tx: noYocto.txHash, ok: noYocto.ok, error: noYocto.error },
  addPublicKey: { tx: add.txHash, explorer: explorer(add.txHash), ok: add.ok, gasBurnt: add.gasBurnt, logs: add.logs },
  hasPublicKey: registered,
  afterRegistration: { ok: after.ok, intentsExecuted: after.intentsExecuted?.length },
  settle: ex && { tx: ex.txHash, explorer: explorer(ex.txHash), ok: ex.ok },
});
log(pass ? 'K4 PASS' : 'K4 FAIL');
