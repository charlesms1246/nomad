// Feature freeze: delete the FullAccess keys of the rings and mandate contract accounts so nobody (the team included)
// can redeploy their code. What remains is listed per account. Irreversible.
// Usage (from apps/matcher): npx tsx ../../scripts/lock-contracts.ts rings.nomadswarm.testnet mandate.nomadswarm.testnet
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NearRpc, signerFor, TESTNET_RPC } from "../packages/intents/src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rpc = new NearRpc(TESTNET_RPC);
const accounts = process.argv.slice(2);
const report: Record<string, unknown> = { at: new Date().toISOString() };
for (const acct of accounts) {
  const keys = (await rpc.call<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: acct })).keys;
  const before = await rpc.call<any>("query", { request_type: "view_account", finality: "final", account_id: acct });
  const txs: string[] = [];
  for (const k of keys.filter((k: any) => k.access_key.permission === "FullAccess")) {
    const r = await rpc.sendTx(signerFor(acct), acct, [{ type: "DeleteKey", publicKey: k.public_key }]);
    console.log(`${acct}: delete FullAccess ${k.public_key} -> ${r.ok ? "ok" : "FAILED " + r.error} ${r.txHash}`);
    txs.push(r.txHash);
  }
  await new Promise((r) => setTimeout(r, 4000));
  const left = (await rpc.call<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: acct })).keys;
  report[acct] = { codeHash: before.code_hash, deleteTxs: txs, remainingKeys: left.map((k: any) => ({ key: k.public_key, permission: k.access_key.permission })) };
  console.log(`${acct}: code ${before.code_hash}, remaining keys ${JSON.stringify(left.map((k: any) => k.access_key.permission))}`);
}
fs.mkdirSync(path.join(ROOT, "docs/measurements"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs/measurements/contract-locks.json"), JSON.stringify(report, null, 1));
