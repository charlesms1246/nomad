// Top up a testnet account from the testnet faucet helper: create a throwaway faucet account,
// then delete it with `beneficiary` as the beneficiary (its whole balance moves over).
// Usage: tsx contracts/verifier/faucet.ts <beneficiary> [rounds=1]
import { NearRpc, randomKeyPair, TESTNET_RPC } from '../../packages/intents/src/index.js';

const beneficiary = process.argv[2] ?? 'nomadswarm.testnet';
const rounds = Number(process.argv[3] ?? 1);
const rpc = new NearRpc(process.env.NEAR_RPC ?? TESTNET_RPC);

for (let i = 0; i < rounds; i++) {
  const kp = randomKeyPair();
  const id = `nomadtmp${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}.testnet`;
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.publicKeyStr }),
  });
  const t = await r.text();
  if (!r.ok) {
    console.error('faucet failed', r.status, t.slice(0, 300));
    process.exit(1);
  }
  // wait for the account to exist
  for (let j = 0; j < 30 && !(await rpc.viewAccount(id)); j++) await new Promise((res) => setTimeout(res, 1000));
  const acct = await rpc.viewAccount(id);
  const out = await rpc.sendTx({ signerId: id, secretKey: kp }, id, [{ type: 'DeleteAccount', beneficiaryId: beneficiary }]);
  console.log(JSON.stringify({ round: i + 1, throwaway: id, amount: acct?.amount, deleteTx: out.txHash, ok: out.ok, error: out.error }));
}
const b = await rpc.viewAccount(beneficiary);
console.log(`${beneficiary} balance: ${Number(BigInt(b!.amount) / 10n ** 21n) / 1000} NEAR`);
