// Make our testnet Verifier verifiable: deploy the EXACT wasm that mainnet intents.near runs.
//
// 1. Read intents.near's code from mainnet (view_code, read-only) and check its sha256 equals
//    intents.near's on-chain code_hash.
// 2. Deploy those bytes to intents.nomadswarm.testnet (same version 0.4.5 / commit 16d04f6 as the
//    build it replaces, so stored state stays compatible).
// 3. Print both code hashes: they must be equal.
// Deleting the account's FullAccess key is a separate, irreversible step: `--delete-full-key`,
// run only after `make dry-run` and a live ring pass on the new code.
//
// Usage: pnpm --filter @nomad/matcher exec tsx ../../scripts/verifier-mainnet-bytes.ts [--deploy] [--delete-full-key]
import { createHash } from "node:crypto";
import { NearRpc, signerFor, TESTNET_RPC, b58encode } from "../packages/intents/src/index.js";

const VERIFIER = process.env.VERIFIER_ID ?? "intents.nomadswarm.testnet";
const MAINNET = new NearRpc("https://free.rpc.fastnear.com");
const TESTNET = new NearRpc(process.env.RPC_URL ?? TESTNET_RPC);
const args = new Set(process.argv.slice(2));

const query = (rpc: NearRpc, params: object) => rpc.call<any>("query", { finality: "final", ...params });

const main = await query(MAINNET, { request_type: "view_account", account_id: "intents.near" });
const code = Buffer.from((await query(MAINNET, { request_type: "view_code", account_id: "intents.near" })).code_base64, "base64");
const hash = b58encode(createHash("sha256").update(code).digest());
console.log(`mainnet intents.near code_hash ${main.code_hash}; downloaded ${code.length} bytes, sha256 ${hash}`);
if (hash !== main.code_hash) throw new Error("downloaded bytes do not match intents.near's code_hash");

const before = await query(TESTNET, { request_type: "view_account", account_id: VERIFIER });
console.log(`${VERIFIER} code_hash before: ${before.code_hash}`);

if (args.has("--deploy")) {
  if (before.code_hash === main.code_hash) console.log("already running mainnet's bytes");
  else {
    const r = await TESTNET.sendTx(signerFor(VERIFIER), VERIFIER, [{ type: "DeployContract", code: new Uint8Array(code) }]);
    console.log(`deploy ${r.ok ? "ok" : "FAILED " + r.error}: ${r.txHash}`);
    const after = await query(TESTNET, { request_type: "view_account", account_id: VERIFIER });
    console.log(`${VERIFIER} code_hash after:  ${after.code_hash} ${after.code_hash === main.code_hash ? "(== intents.near)" : "(MISMATCH)"}`);
  }
}

if (args.has("--delete-full-key")) {
  const keys = (await query(TESTNET, { request_type: "view_access_key_list", account_id: VERIFIER })).keys as { public_key: string; access_key: { permission: unknown } }[];
  const full = keys.filter((k) => k.access_key.permission === "FullAccess");
  for (const k of full) {
    const r = await TESTNET.sendTx(signerFor(VERIFIER), VERIFIER, [{ type: "DeleteKey", publicKey: k.public_key }]);
    console.log(`delete FullAccess key ${k.public_key}: ${r.ok ? "ok" : "FAILED " + r.error} ${r.txHash}`);
  }
  const left = (await query(TESTNET, { request_type: "view_access_key_list", account_id: VERIFIER })).keys;
  console.log(`remaining keys: ${JSON.stringify(left.map((k: any) => [k.public_key, k.access_key.permission === "FullAccess" ? "FullAccess" : k.access_key.permission]))}`);
}
