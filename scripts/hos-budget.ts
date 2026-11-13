// HoS budgets demo (IDEA.md §14 item 4), TESTNET ONLY.
//
// An agent's name is a House of Stake hos-wallet account (unmodified houseofstake/tla-contracts
// d85860a): no access keys, owned by a treasury account. The treasury gives the agent runtime an
// `hos_grant_spend` grant with a 1 USDC token budget. The runtime moves USDC out of the name under
// that grant and deposits it into our Intents Verifier (intents.nomadswarm.testnet), credited to
// the name. A second deposit over budget, a receiver outside the grant, and a direct
// ft_transfer_call from the wallet all fail with the wallet's own errors.
//
// Build first: contracts/hos/build.sh   (or set HOS_WALLET_WASM)
// Run:         pnpm --filter @nomad/matcher exec tsx ../../scripts/hos-budget.ts
// Output:      docs/measurements/hos-budget.json
//
// Idempotent: accounts and the wallet are created once; later runs renew the lease (authority's
// hos_set_lease), revoke + re-grant (which resets the meter) and top the name up with USDC.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NearRpc,
  ONE_NEAR,
  TESTNET_RPC,
  TESTNET_RPC_FALLBACKS,
  TGAS,
  b58encode,
  hasCredentials,
  randomKeyPair,
  saveCredentials,
  signerFor,
  type TxOutcome,
} from '../packages/intents/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config/testnet.json'), 'utf8'));
if (CONFIG.network !== 'testnet') throw new Error('testnet only');

const PARENT = process.env.PARENT ?? 'nomadswarm.testnet';
const VERIFIER: string = CONFIG.verifierId; // intents.nomadswarm.testnet
const USDC = `usdc.${PARENT}`;
const USDC_ID = `nep141:${USDC}`;
const TLA = `tla.${PARENT}`; // the TLA account; plays the registrar's role (see docs/HOS_BUDGETS.md)
const TREASURY = `treasury.${PARENT}`; // owner of the agent's name
const AUTHORITY = `hosauth.${PARENT}`; // lease authority; plays the hos-extension's role
const RUNTIME = `hosrt.${PARENT}`; // agent runtime = the granted extension
const COLLECTION = `registry.${TLA}`; // collection id written into the wallet (no registry deployed)
const AGENT = process.env.HOS_AGENT ?? `nomad-agent-01.${TLA}`; // the leased name
const OUTSIDER = `a01.${PARENT}`; // a receiver that is NOT in the grant

const LEASE_TERM_NS = 10n * 60n * 1_000_000_000n; // 10 minute lease
const GRANT_TERM_NS = 9n * 60n * 1_000_000_000n;
const USDC_UNIT = 1_000_000n; // 6 decimals
const BUDGET = 1n * USDC_UNIT; // 1 USDC
const DEPOSIT = 600_000n; // 0.6 USDC
const WALLET_FLOAT = 2n * USDC_UNIT; // USDC kept on the name before each run
const WASM_PATH = process.env.HOS_WALLET_WASM ?? '/tmp/hos/tla-contracts/target/near/hos_wallet/hos_wallet.wasm';

const rpc = new NearRpc(process.env.NEAR_RPC ?? TESTNET_RPC, TESTNET_RPC_FALLBACKS);
const parent = signerFor(PARENT);
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;
const near = (y: bigint | string) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toFixed(4);

interface Row {
  step: string;
  signer: string;
  receiver: string;
  method: string;
  expect: 'success' | 'failure';
  ok: boolean;
  passed: boolean;
  txHash: string;
  explorer: string;
  error?: string;
  gasBurnt: string;
  note?: string;
}
const rows: Row[] = [];
const out: any = { network: 'testnet', startedAt: new Date().toISOString() };

async function tx(
  step: string,
  signer: { signerId: string; secretKey: any },
  receiver: string,
  actions: any[],
  expect: 'success' | 'failure',
  expectError?: string,
  note?: string,
): Promise<TxOutcome> {
  const r = await rpc.sendTx(signer, receiver, actions);
  // A wallet call that schedules promises succeeds at the top level even if a child receipt
  // fails, so also look for any failed receipt.
  const failedReceipt = (r.raw?.receipts_outcome ?? []).find((o: any) => o.outcome?.status?.Failure);
  const ok = r.ok && !failedReceipt;
  const error = r.error ?? (failedReceipt ? JSON.stringify(failedReceipt.outcome.status.Failure) : undefined);
  const passed = expect === 'success' ? ok : !ok && (!expectError || (error ?? '').includes(expectError));
  const method = actions.map((a) => (a.type === 'FunctionCall' ? a.methodName : a.type)).join('+');
  rows.push({ step, signer: signer.signerId, receiver, method, expect, ok, passed, txHash: r.txHash, explorer: explorer(r.txHash), error, gasBurnt: r.gasBurnt, note });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${step}: ${method} ${r.txHash} ok=${ok}${error ? ' error=' + error : ''}`);
  if (!passed) {
    save();
    throw new Error(`step "${step}" did not behave as expected`);
  }
  return r;
}

const call = (methodName: string, args: object, deposit = 0n, gas = 100n * TGAS) => ({ type: 'FunctionCall', methodName, args, gas, deposit });

/** A wallet Request (defuse-wallet JSON): one external promise with one function call. */
const fnPromise = (receiver_id: string, function_name: string, args: object, gasT = 30n) => ({
  receiver_id,
  actions: [
    {
      action: 'function_call',
      payload: {
        function_name,
        args: Buffer.from(JSON.stringify(args)).toString('base64'),
        deposit: '1',
        gas: (gasT * TGAS).toString(),
      },
    },
  ],
});

async function now(): Promise<bigint> {
  const b: any = await rpc.call('block', { finality: 'final' });
  return BigInt(b.header.timestamp_nanosec);
}

async function ensureKeyAccount(id: string, balance: bigint) {
  if (await rpc.viewAccount(id)) {
    if (!hasCredentials(id)) throw new Error(`${id} exists but its key is not in ~/.near-credentials/testnet`);
    console.log(`= ${id} exists`);
    return;
  }
  if (hasCredentials(id)) throw new Error(`credentials for ${id} exist but the account does not; remove them first`);
  const kp = randomKeyPair();
  saveCredentials({ account_id: id, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
  await tx(`create ${id}`, parent, id, [
    { type: 'CreateAccount' },
    { type: 'Transfer', deposit: balance },
    { type: 'AddKey', publicKey: kp.publicKeyStr, permission: 'FullAccess' },
  ], 'success');
}

async function ftBalance(token: string, who: string): Promise<bigint> {
  return BigInt(await rpc.view<string>(token, 'ft_balance_of', { account_id: who }));
}
async function mtBalance(who: string): Promise<bigint> {
  return BigInt(await rpc.view<string>(VERIFIER, 'mt_balance_of', { account_id: who, token_id: USDC_ID }));
}

/** Appends this run to docs/measurements/hos-budget.json ({ runs: [...] }); earlier runs are kept. */
function save() {
  out.finishedAt = new Date().toISOString();
  out.txs = rows;
  const f = join(ROOT, 'docs/measurements/hos-budget.json');
  mkdirSync(dirname(f), { recursive: true });
  let doc: any = { runs: [] };
  try {
    const prev = JSON.parse(readFileSync(f, 'utf8'));
    doc = Array.isArray(prev.runs) ? prev : { runs: [prev] };
  } catch {}
  doc.runs = doc.runs.filter((r: any) => r.startedAt !== out.startedAt);
  doc.runs.push(out);
  writeFileSync(f, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${f}`);
}

// ---------------------------------------------------------------------------------------------
const wasm = new Uint8Array(readFileSync(WASM_PATH));
const sha = createHash('sha256').update(wasm).digest();
out.upstream = {
  repo: 'https://github.com/houseofstake/tla-contracts',
  commit: 'd85860a8cc2bfcb8b617b28cab558da5d39333fc',
  contract: 'hos-wallet (unmodified)',
  wasmBytes: wasm.length,
  wasmSha256: sha.toString('hex'),
  codeHashB58: b58encode(sha),
};
out.accounts = { parent: PARENT, tla: TLA, treasury: TREASURY, authority: AUTHORITY, runtime: RUNTIME, collectionId: COLLECTION, agent: AGENT, verifier: VERIFIER, token: USDC, outsider: OUTSIDER };
const startBal = BigInt((await rpc.viewAccount(PARENT))!.amount);
console.log(`${PARENT}: ${near(startBal)} NEAR; hos_wallet ${wasm.length} B sha256 ${out.upstream.wasmSha256}`);

// 1. Accounts ---------------------------------------------------------------------------------
console.log('\n== 1. accounts');
// The wallet's storage: code + state, at 1e19 yocto/byte, plus headroom for the 5 mNEAR renter buffer.
const walletFunding = BigInt(wasm.length + 4_000) * 10n ** 19n + ONE_NEAR / 10n;
await ensureKeyAccount(TLA, walletFunding + ONE_NEAR / 10n);
await ensureKeyAccount(TREASURY, ONE_NEAR / 5n);
await ensureKeyAccount(AUTHORITY, ONE_NEAR / 10n);
await ensureKeyAccount(RUNTIME, ONE_NEAR / 5n);

// 2. The leased name --------------------------------------------------------------------------
console.log('\n== 2. lease the name');
const agentAcct = await rpc.viewAccount(AGENT);
if (!agentAcct) {
  // The TLA account pays the name's funding plus the tx's prepaid gas (~0.04 NEAR at 300 Tgas).
  const need = walletFunding + ONE_NEAR / 5n;
  const has = BigInt((await rpc.viewAccount(TLA))!.amount);
  if (has < need) await tx(`top up ${TLA}`, parent, TLA, [{ type: 'Transfer', deposit: need - has }], 'success');
  const t = await now();
  // Same init args and order as registrar::create_sub_account (contracts/registrar/src/lib.rs:146-185):
  // create, fund, code, hos_init called by the direct parent. The registrar uses
  // use_global_contract_by_account_id; we deploy the identical wasm directly (see HOS_BUDGETS.md).
  const r = await tx('mint name (create + deploy hos-wallet + hos_init)', signerFor(TLA), AGENT, [
    { type: 'CreateAccount' },
    { type: 'Transfer', deposit: walletFunding },
    { type: 'DeployContract', code: wasm },
    call('hos_init', {
      config: {
        owner_account: TREASURY,
        authority: AUTHORITY,
        collection_id: COLLECTION,
        payout_account: TREASURY,
        lease_until_ns: (t + LEASE_TERM_NS).toString(),
        timeout_secs: 3600,
      },
    }),
  ], 'success');
  out.mint = { txHash: r.txHash, leaseTermSec: Number(LEASE_TERM_NS / 1_000_000_000n) };
} else {
  if (agentAcct.code_hash !== out.upstream.codeHashB58) throw new Error(`${AGENT} runs ${agentAcct.code_hash}, not our hos-wallet build`);
  console.log(`= ${AGENT} exists with hos-wallet ${agentAcct.code_hash}`);
}
let lease: any = await rpc.view(AGENT, 'hos_lease');
{
  const t = await now();
  if (BigInt(lease.lease_until_ns) < t + GRANT_TERM_NS) {
    // Renewal: the authority pushes a new lease end, as tla-registry does through hos-extension.
    await tx('renew lease (authority hos_set_lease)', signerFor(AUTHORITY), AGENT, [
      call('hos_set_lease', { lease_until_ns: (t + LEASE_TERM_NS).toString(), state: 'Active' }, 1n, 30n * TGAS),
    ], 'success', undefined, 'stand-in for tla-registry renew_sub_account -> hos-extension -> hos_set_lease');
    lease = await rpc.view(AGENT, 'hos_lease');
  }
}
const keys: any = await rpc.call('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: AGENT });
out.name = {
  account: AGENT,
  accessKeys: keys.keys.length,
  signatureAllowed: await rpc.view(AGENT, 'w_is_signature_allowed'),
  lease,
  nftItemInfo: await rpc.view(AGENT, 'nft_item_info'),
};
console.log(`  access keys ${keys.keys.length}, lease until ${new Date(Number(BigInt(lease.lease_until_ns) / 1_000_000n)).toISOString()}`);

// Storage on the token for the name and the runtime, then the name's USDC float.
for (const who of [AGENT, RUNTIME]) {
  if (!(await rpc.view(USDC, 'storage_balance_of', { account_id: who }))) {
    await tx(`usdc storage_deposit ${who}`, parent, USDC, [call('storage_deposit', { account_id: who, registration_only: true }, 1_250_000_000_000_000_000_000n, 10n * TGAS)], 'success');
  }
}
const held = await ftBalance(USDC, AGENT);
if (held < WALLET_FLOAT) {
  await tx('fund name with test USDC', parent, USDC, [call('ft_transfer', { receiver_id: AGENT, amount: (WALLET_FLOAT - held).toString() }, 1n, 10n * TGAS)], 'success');
}

// 3. Grant ------------------------------------------------------------------------------------
console.log('\n== 3. treasury grants the runtime a USDC budget');
const treasury = signerFor(TREASURY);
const runtime = signerFor(RUNTIME);
if (!(await rpc.view(AGENT, 'w_is_extension_enabled', { account_id: RUNTIME }))) {
  await tx('owner enables the runtime as an extension', treasury, AGENT, [
    call('w_execute_extension', { request: { internal: [{ op: 'add_extension', payload: { account_id: RUNTIME } }] } }, 1n, 50n * TGAS),
  ], 'success');
}
if (await rpc.view(AGENT, 'hos_spend_grant', { extension: RUNTIME })) {
  await tx('owner revokes the old grant (resets the meter)', treasury, AGENT, [call('hos_revoke_spend', { extension: RUNTIME }, 1n, 30n * TGAS)], 'success');
}
const tGrant = await now();
const expiresAt = (tGrant + GRANT_TERM_NS).toString();
const grantArgs = {
  extension: RUNTIME,
  receivers: [RUNTIME],
  budget_yocto: '0',
  tokens: [{ token: USDC, budget: BUDGET.toString() }],
  items: [],
  expires_at: expiresAt,
};
await tx('grant naming the own collection is refused', treasury, AGENT, [
  call('hos_grant_spend', { ...grantArgs, tokens: [{ token: COLLECTION, budget: '1' }] }, 1n, 30n * TGAS),
], 'failure', 'a spend grant cannot move this account\'s own names', 'OWN_COLLECTION_NOT_GRANTABLE');
const grantTx = await tx('hos_grant_spend: 1 USDC to the runtime', treasury, AGENT, [call('hos_grant_spend', grantArgs, 1n, 30n * TGAS)], 'success');
out.grant = { args: grantArgs, txHash: grantTx.txHash, view: await rpc.view(AGENT, 'hos_spend_grant', { extension: RUNTIME }) };

// 4. Deposits under the budget ----------------------------------------------------------------
console.log('\n== 4. runtime deposits into the Verifier under the grant');
const pull = (amount: bigint, receiver = RUNTIME) =>
  call('w_execute_extension', { request: { external: [fnPromise(USDC, 'ft_transfer', { receiver_id: receiver, amount: amount.toString() }, 15n)] } }, 1n, 100n * TGAS);
const before = { verifier: await mtBalance(AGENT), name: await ftBalance(USDC, AGENT), runtime: await ftBalance(USDC, RUNTIME) };

const d1a = await tx('deposit 1, hop 1: name -> runtime 0.6 USDC (metered by the grant)', runtime, AGENT, [pull(DEPOSIT)], 'success');
const d1b = await tx('deposit 1, hop 2: runtime ft_transfer_call 0.6 USDC into the Verifier for the name', runtime, USDC, [
  call('ft_transfer_call', { receiver_id: VERIFIER, amount: DEPOSIT.toString(), msg: AGENT }, 1n, 100n * TGAS),
], 'success');
const after1 = { verifier: await mtBalance(AGENT), name: await ftBalance(USDC, AGENT), runtime: await ftBalance(USDC, RUNTIME) };
if (after1.verifier - before.verifier !== DEPOSIT) throw new Error(`Verifier credit ${after1.verifier - before.verifier}, expected ${DEPOSIT}`);
console.log(`  mt_balance_of(${AGENT}, ${USDC_ID}) ${before.verifier} -> ${after1.verifier}`);

const d2 = await tx('deposit 2, hop 1: another 0.6 USDC (1.2 > 1.0 budget)', runtime, AGENT, [pull(DEPOSIT)], 'failure', 'spend exceeds the granted cap for this token', 'TOKEN_CAP_EXCEEDED; hop 2 is never reached');
const outsider = await tx('receiver outside the grant: 0.1 USDC to ' + OUTSIDER, runtime, AGENT, [pull(100_000n, OUTSIDER)], 'failure', 'receiver is not in the spend grant', 'RECEIVER_NOT_GRANTED');
const direct = await tx('direct ft_transfer_call from the name into the Verifier', runtime, AGENT, [
  call('w_execute_extension', { request: { external: [fnPromise(USDC, 'ft_transfer_call', { receiver_id: VERIFIER, amount: '100000', msg: AGENT }, 60n)] } }, 1n, 120n * TGAS),
], 'failure', 'a spend grant covers ft_transfer and nft_transfer only', 'GRANT_METHOD_NOT_ALLOWED: why the deposit takes two hops');
const after = { verifier: await mtBalance(AGENT), name: await ftBalance(USDC, AGENT), runtime: await ftBalance(USDC, RUNTIME) };
if (after.verifier !== after1.verifier || after.name !== after1.name) throw new Error('a failed step moved funds');

out.deposits = {
  amount: DEPOSIT.toString(),
  budget: BUDGET.toString(),
  ok: { hop1: d1a.txHash, hop2: d1b.txHash },
  overBudget: d2.txHash,
  outsideReceiver: outsider.txHash,
  directTransferCall: direct.txHash,
  balances: Object.fromEntries(Object.entries({ before, afterFirstDeposit: after1, final: after }).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, b.toString()]))])),
  grantAfter: await rpc.view(AGENT, 'hos_spend_grant', { extension: RUNTIME }),
};
const endBal = BigInt((await rpc.viewAccount(PARENT))!.amount);
out.parentNearSpentThisRun = near(startBal - endBal);
out.allPassed = rows.every((r) => r.passed);
console.log(`\nverifier ${before.verifier} -> ${after.verifier}; grant spent ${out.deposits.grantAfter.tokens[USDC].spent}/${BUDGET}; ${PARENT} spent ${out.parentNearSpentThisRun} NEAR`);
save();
