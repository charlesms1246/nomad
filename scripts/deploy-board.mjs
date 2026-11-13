#!/usr/bin/env node
// Deploy the Nomad offer board to board.nomadswarm.testnet (TESTNET ONLY).
//
// Prereqs:
//   (cd contracts/board && cargo near build non-reproducible-wasm)
//   npm i --prefix /tmp/nomad-deploy near-api-js@7.5.3     # deps live outside the repo
//
// Usage:
//   node --dns-result-order=ipv4first scripts/deploy-board.mjs            # first deploy
//   node --dns-result-order=ipv4first scripts/deploy-board.mjs --redeploy # code only
//
// First deploy, in one atomic tx signed by the parent: CreateAccount, Transfer
// (BOARD_FUNDING, max 3 NEAR), AddKey (new full-access key, saved first to
// ~/.near-credentials/testnet/board.nomadswarm.testnet.json), DeployContract and
// new(owner, sha256(RULES.md), "RULES.md"). A second tx from the parent (the
// owner) registers the matchers. --redeploy pushes new code with the board key
// and does not re-init (state layout must stay compatible).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEPS = process.env.NEAR_DEPS_DIR || '/tmp/nomad-deploy';
const nearPath = createRequire(join(DEPS, 'package.json')).resolve('near-api-js');
const { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } = await import(
  pathToFileURL(nearPath.replace(/index\.cjs$/, 'index.js')).href
);

const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
const PARENT = 'nomadswarm.testnet';
const BOARD = 'board.nomadswarm.testnet';
const MATCHERS = ['matcher.nomadswarm.testnet', 'intents-matcher.nomadswarm.testnet'];
const FUNDING = process.env.BOARD_FUNDING || '3';
if (!RPC.includes('test') || !BOARD.endsWith('.testnet')) throw new Error('testnet only');
if (Number(FUNDING) > 3) throw new Error('BOARD_FUNDING must be <= 3 NEAR');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = readFileSync(join(root, 'contracts/board/target/near/nomad_board.wasm'));
const rulesSha = createHash('sha256').update(readFileSync(join(root, 'RULES.md'))).digest('hex');
const credDir = join(homedir(), '.near-credentials/testnet');
const loadKey = (id) => JSON.parse(readFileSync(join(credDir, `${id}.json`), 'utf8')).private_key;

const provider = new JsonRpcProvider({ url: RPC });
const parent = new Account(PARENT, provider, loadKey(PARENT));
const redeploy = process.argv.includes('--redeploy');

async function exists(id) {
  try {
    await provider.query({ request_type: 'view_account', finality: 'final', account_id: id });
    return true;
  } catch {
    return false;
  }
}

const hashOf = (r) => r?.transaction?.hash ?? r?.transaction_outcome?.id;

console.log(`rpc=${RPC} wasm=${wasm.length} bytes rules_sha256=${rulesSha}`);

if (redeploy) {
  const board = new Account(BOARD, provider, loadKey(BOARD));
  const r = await board.deployContract(new Uint8Array(wasm));
  console.log('redeploy tx', hashOf(r));
} else {
  if (await exists(BOARD)) throw new Error(`${BOARD} already exists; use --redeploy`);
  const credPath = join(credDir, `${BOARD}.json`);
  if (existsSync(credPath)) throw new Error(`${credPath} exists; refusing to overwrite`);
  const kp = KeyPair.fromRandom('ed25519');
  mkdirSync(credDir, { recursive: true });
  writeFileSync(
    credPath,
    JSON.stringify({ account_id: BOARD, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }),
    { mode: 0o600 },
  );
  console.log('saved key', credPath, kp.getPublicKey().toString());

  const r = await parent.signAndSendTransaction({
    receiverId: BOARD,
    actions: [
      actions.createAccount(),
      actions.transfer(BigInt(nearToYocto(FUNDING))),
      actions.addFullAccessKey(kp.getPublicKey()),
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall(
        'new',
        { owner_id: PARENT, rules_sha256: rulesSha, rules_url: 'RULES.md' },
        teraToGas('30'),
        0n,
      ),
    ],
  });
  console.log('create+deploy+init tx', hashOf(r));
}

// Matchers (owner = parent). add_matcher is idempotent.
const r2 = await parent.signAndSendTransaction({
  receiverId: BOARD,
  actions: MATCHERS.map((m) => actions.functionCall('add_matcher', { account_id: m }, teraToGas('10'), 0n)),
});
console.log('add_matcher tx', hashOf(r2));

const view = async (method, args = {}) => {
  const res = await provider.query({
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: BOARD,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(res.result).toString());
};
console.log('rules', await view('rules'));
console.log('matchers', await view('matchers'));
console.log('stats', await view('stats'));
