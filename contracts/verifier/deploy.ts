// Deploy and initialise our near/intents Verifier (defuse) build and the test NEP-141 tokens on testnet.
// Idempotent: existing accounts / contracts / registrations are skipped.
//
// Usage: tsx contracts/verifier/deploy.ts [--wasm path/to/defuse.wasm] [--ft path/to/fungible-token.wasm]
// Env: PARENT (default nomadswarm.testnet), NEAR_RPC
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  IntentsClient,
  NearRpc,
  ONE_NEAR,
  TESTNET_RPC,
  TGAS,
  b58encode,
  hasCredentials,
  loadCredentials,
  randomKeyPair,
  saveCredentials,
  signerFor,
} from '../../packages/intents/src/index.js';
import { TOKENS, VERIFIER_FEE_COLLECTOR, VERIFIER_FEE_PIPS, WNEAR_ID } from './config.js';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1]! : d;
};
const PARENT = process.env.PARENT ?? 'nomadswarm.testnet';
const VERIFIER = `intents.${PARENT}`;
const WASM = arg('--wasm', '/tmp/nirsrc/intents-045/target/near/defuse/defuse.wasm');
const FT_WASM = arg('--ft', '/tmp/nirsrc/intents-045/releases/fungible-token.wasm');

const rpc = new NearRpc(process.env.NEAR_RPC ?? TESTNET_RPC);
const client = new IntentsClient({ rpc, verifierId: VERIFIER });
const parent = signerFor(PARENT);

const codeHash = (b: Uint8Array) => b58encode(createHash('sha256').update(b).digest());

async function ensureAccountWithCode(id: string, code: Uint8Array, initialNear: bigint, init: { method: string; args: object }) {
  const want = codeHash(code);
  const acct = await rpc.viewAccount(id);
  if (acct && acct.code_hash === want) {
    console.log(`= ${id} already has code ${want}`);
    return;
  }
  if (acct) throw new Error(`${id} exists with code ${acct.code_hash}, expected ${want}; refusing to overwrite`);
  const kp = randomKeyPair();
  if (hasCredentials(id)) throw new Error(`credentials for ${id} exist but account does not; remove them first`);
  saveCredentials({ account_id: id, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
  const out = await rpc.sendTx(parent, id, [
    { type: 'CreateAccount' },
    { type: 'Transfer', deposit: initialNear },
    { type: 'AddKey', publicKey: kp.publicKeyStr, permission: 'FullAccess' },
    { type: 'DeployContract', code },
    { type: 'FunctionCall', methodName: init.method, args: init.args, gas: 100n * TGAS, deposit: 0n },
  ]);
  console.log(`+ ${id}: create+deploy+${init.method} tx ${out.txHash} ok=${out.ok} gas=${out.gasBurnt}${out.error ? ' error=' + out.error : ''}`);
  if (!out.ok) throw new Error(`deploy of ${id} failed`);
}

// 1. Verifier
const wasm = new Uint8Array(readFileSync(WASM));
console.log(`defuse wasm ${WASM}: ${wasm.length} bytes, sha256(b58) ${codeHash(wasm)}`);
await ensureAccountWithCode(VERIFIER, wasm, 17n * ONE_NEAR, {
  method: 'new',
  args: {
    config: {
      wnear_id: WNEAR_ID,
      fees: { fee: VERIFIER_FEE_PIPS, fee_collector: VERIFIER_FEE_COLLECTOR },
      roles: { super_admins: [PARENT], admins: {}, grantees: {} },
    },
  },
});
console.log(`  fee=${await client.fee()} collector=${await client.feeCollector()} salt=${await client.currentSalt()}`);

// 2. Test tokens (owner = parent, whole supply minted to the parent)
const ft = new Uint8Array(readFileSync(FT_WASM));
for (const t of TOKENS) {
  const id = `${t.sub}.${PARENT}`;
  await ensureAccountWithCode(id, ft, (23n * ONE_NEAR) / 10n, {
    method: 'new',
    args: {
      owner_id: PARENT,
      total_supply: t.supply.toString(),
      metadata: { spec: 'ft-1.0.0', name: t.name, symbol: t.symbol, icon: null, reference: null, reference_hash: null, decimals: t.decimals },
    },
  });
}

// 3. Register the verifier (and the parent, for wrap.testnet) on every token
for (const token of [...TOKENS.map((t) => `${t.sub}.${PARENT}`), WNEAR_ID]) {
  for (const who of token === WNEAR_ID ? [VERIFIER, PARENT] : [VERIFIER]) {
    const bal: any = await rpc.view(token, 'storage_balance_of', { account_id: who });
    if (bal) {
      console.log(`= ${who} registered on ${token}`);
      continue;
    }
    const out = await client.storageDeposit(parent, token, who);
    console.log(`+ storage_deposit ${who} on ${token}: ${out.txHash} ok=${out.ok}${out.error ? ' ' + out.error : ''}`);
  }
}

const p = await rpc.viewAccount(PARENT);
console.log(`${PARENT} balance now ${Number(BigInt(p!.amount) / 10n ** 21n) / 1000} NEAR`);
console.log(`verifier credentials: ~/.near-credentials/testnet/${VERIFIER}.json (pk ${loadCredentials(VERIFIER).public_key})`);
