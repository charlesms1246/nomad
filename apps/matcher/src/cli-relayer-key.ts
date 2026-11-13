#!/usr/bin/env node
// make relayer-key: give the matcher a function-call key ON the Verifier account, limited to
// `execute_intents` with no allowance. This mirrors mainnet, where intents.near holds 9 such keys
// and its relayer signs as the contract. Same-block execution needs signer == receiver (a local
// receipt; docs/research/SHARD_LATENCY.md). The key can only submit batches; every intent inside
// still needs its owner's signature, so it cannot move anyone's funds.
// Needs the Verifier account's full-access key (~/.near-credentials/testnet/<verifier>.json).
import fs from "node:fs";
import path from "node:path";
import { NearRpc, randomKeyPair, signerFor, TESTNET_RPC } from "@nomad/intents";
import { loadConfig, keysDir } from "./config.js";

async function main() {
  const cfg = loadConfig();
  const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
  const file = path.join(keysDir(), `${cfg.verifierId}.relayer.json`);
  if (fs.existsSync(file)) {
    const k = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`relayer key exists: ${k.public_key} (${file})`);
    return;
  }
  const kp = randomKeyPair();
  const r = await rpc.sendTx(signerFor(cfg.verifierId), cfg.verifierId, [
    { type: "AddKey", publicKey: kp.publicKeyStr, permission: { receiverId: cfg.verifierId, methodNames: ["execute_intents"] } },
  ]);
  if (!r.ok) throw new Error(`AddKey failed: ${r.error}`);
  fs.mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ account_id: cfg.verifierId, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr }), { mode: 0o600 });
  console.log(`added function-call key ${kp.publicKeyStr} on ${cfg.verifierId} (execute_intents only): ${r.txHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
