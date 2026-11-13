// K7: an execute_intents tx sent from an account on the Verifier's shard executes in the inclusion
// block; from another shard it executes one block later. N txs from each, interleaved.
// The shard layout is read live (EXPERIMENTAL_protocol_config); nothing is hard-coded.
import { ONE_NEAR, hasCredentials, loadCredentials, randomKeyPair, saveCredentials, signIntents } from '../packages/intents/src/index.js';
import { client, CONFIG, explorer, fundAgents, implicitAgent, log, parent, PARENT, rpc, saveResult, T } from './k-lib.js';

const N = Number(process.argv[2] ?? 20);
const cfg: any = await rpc.call('EXPERIMENTAL_protocol_config', { finality: 'final' });
const layout = Object.values(cfg.shard_layout)[0] as { boundary_accounts: string[]; shard_ids: number[] };
const shardOf = (id: string) => layout.shard_ids[layout.boundary_accounts.filter((b) => Buffer.compare(Buffer.from(b), Buffer.from(id)) <= 0).length]!;
const vShard = shardOf(CONFIG.verifierId);

const COLO = `k7colo.${PARENT}`, CTL = `zk7ctl.${PARENT}`;
if (shardOf(COLO) !== vShard || shardOf(CTL) === vShard) throw new Error('pick other K7 names for this layout');
for (const id of [COLO, CTL]) {
  if (await rpc.viewAccount(id)) continue;
  const kp = randomKeyPair();
  if (hasCredentials(id)) throw new Error(`stale credentials for ${id}`);
  saveCredentials({ account_id: id, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
  const r = await rpc.sendTx(parent, id, [{ type: 'CreateAccount' }, { type: 'Transfer', deposit: ONE_NEAR / 2n }, { type: 'AddKey', publicKey: kp.publicKeyStr, permission: 'FullAccess' }]);
  log('created', id, r.txHash, r.ok);
}
const submitters = [COLO, CTL].map((id) => ({ id, shard: shardOf(id), signer: { signerId: id, secretKey: loadCredentials(id).private_key } }));

// One funded agent signs 2N independent 1-unit transfers (fee-free), one per tx.
const W = T.wNEAR!.id;
const src = implicitAgent(), dst = implicitAgent();
await fundAgents([{ to: src.id, tokens: { [W]: BigInt(4 * N) } }]);
const salt = await client.currentSalt();
const rows: any[] = [];
for (let i = 0; i < N; i++) {
  for (const s of submitters) {
    const signed = signIntents({ signerId: src.id, secretKey: src.secretKey, verifierId: CONFIG.verifierId, salt, deadline: new Date(Date.now() + 600_000), intents: [{ intent: 'transfer', receiver_id: dst.id, tokens: { [W]: '1' } }] });
    const ex = await client.execute([signed], s.signer);
    const row = { from: s.id, shard: s.shard, tx: ex.txHash, ok: ex.ok, included: ex.blockHeight, executed: ex.receiptBlockHeights[0], blocksToExecute: ex.receiptBlockHeights[0]! - ex.blockHeight };
    rows.push(row);
    log(JSON.stringify(row));
  }
}
const summary = submitters.map((s) => {
  const r = rows.filter((x) => x.from === s.id && x.ok);
  const hist: Record<number, number> = {};
  for (const x of r) hist[x.blocksToExecute] = (hist[x.blocksToExecute] ?? 0) + 1;
  return { account: s.id, shard: s.shard, sameShardAsVerifier: s.shard === vShard, n: r.length, sameBlock: r.filter((x) => x.blocksToExecute === 0).length, histogram: hist };
});
const colo = summary[0]!;
const pass = colo.n >= N && colo.sameBlock === colo.n;
saveResult('k7-colo', { pass, N, verifierShard: vShard, layout, summary, rows: rows.map((r) => ({ ...r, explorer: explorer(r.tx) })) });
log(JSON.stringify(summary));
log(pass ? 'K7 PASS' : 'K7 FAIL');
