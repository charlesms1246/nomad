#!/usr/bin/env node
// make accounts: create the testnet agent and matcher sub-accounts under nomadswarm.testnet,
// give each agent a separate Verifier signing key (add_public_key) and a board function-call key.
// Idempotent: existing accounts and keys are kept. Keys go to ~/.near-credentials/testnet (full
// access) and ./keys (Verifier + board keys); both are outside git.
//   AGENTS=12  PARENT=nomadswarm.testnet  AGENT_NEAR=0.4  MATCHER_NEAR=0.5
import fs from "node:fs";
import path from "node:path";
import { IntentsClient, NearRpc, randomKeyPair, hasCredentials, saveCredentials, signerFor, ONE_NEAR, TESTNET_RPC } from "@nomad/intents";
import { place, check } from "@nomad/colo";
import { loadConfig, agentIds, keysDir } from "./config.js";

const env = (k: string, d: string) => process.env[k] ?? d;
const near = (x: string) => (BigInt(Math.round(parseFloat(x) * 1000)) * ONE_NEAR) / 1000n;

async function main() {
  const cfg = loadConfig();
  const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
  const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
  const parent = cfg.parent;
  const p = signerFor(parent);
  const kdir = keysDir();
  fs.mkdirSync(kdir, { recursive: true, mode: 0o700 });

  // 1. matcher accounts: production on the Verifier's shard (colo place), control elsewhere
  let prodMatcher = cfg.matcherId;
  // Reuse our existing production matcher; `colo place` only for a fresh setup (it skips taken names).
  if (!prodMatcher && hasCredentials(`intents-matcher.${parent}`)) prodMatcher = `intents-matcher.${parent}`;
  if (!prodMatcher) {
    prodMatcher = (await place(cfg.verifierId, { parent, hint: "intents-matcher", network: "testnet" })).accountId;
  }
  const control = cfg.controlMatcherId ?? `matcher.${parent}`;
  const ck = await check({ account: prodMatcher, target: cfg.verifierId }, { network: "testnet" });
  const cc = await check({ account: control, target: cfg.verifierId }, { network: "testnet" });
  console.log(`matcher ${prodMatcher}: shard ${ck.accountShard} (verifier ${ck.targetShard}) colocated=${ck.colocated}`);
  console.log(`control ${control}: shard ${cc.accountShard} colocated=${cc.colocated}`);
  if (!ck.colocated) throw new Error("production matcher is not on the Verifier's shard; set matcherId via colo place");
  if (cc.colocated) throw new Error("control matcher must be on a different shard");

  const ids = [...agentIds(+env("AGENTS", "12"), parent), prodMatcher, control];
  for (const id of ids) {
    const isMatcher = id === prodMatcher || id === control;
    if (!(await rpc.viewAccount(id))) {
      const kp = randomKeyPair();
      const amt = near(env(isMatcher ? "MATCHER_NEAR" : "AGENT_NEAR", isMatcher ? "0.5" : "0.4"));
      const r = await rpc.sendTx(p, id, [
        { type: "CreateAccount" },
        { type: "Transfer", deposit: amt },
        { type: "AddKey", publicKey: kp.publicKeyStr, permission: "FullAccess" },
      ]);
      if (!r.ok) throw new Error(`create ${id}: ${r.error}`);
      saveCredentials({ account_id: id, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
      console.log(`created ${id} (${r.txHash})`);
    } else if (!hasCredentials(id)) {
      throw new Error(`${id} exists but its key is not in ~/.near-credentials/testnet`);
    }
    const full = signerFor(id);

    // 2. a separate Verifier signing key, registered with add_public_key (BUILD_PLAN C7)
    const ikFile = path.join(kdir, `${id}.intents.json`);
    if (!fs.existsSync(ikFile)) {
      const kp = randomKeyPair();
      fs.writeFileSync(ikFile, JSON.stringify({ account_id: id, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr }), { mode: 0o600 });
    }
    const ik = JSON.parse(fs.readFileSync(ikFile, "utf8"));
    if (!(await intents.hasPublicKey(id, ik.public_key))) {
      const r = await intents.addPublicKey(full, ik.public_key);
      if (!r.ok) throw new Error(`add_public_key ${id}: ${r.error}`);
      console.log(`registered Verifier key for ${id} (${r.txHash})`);
    }

    // 3. agents: a board function-call key that can only post/cancel offers (cannot move funds)
    if (!isMatcher && cfg.boardId && process.env.SKIP_BOARD_KEYS !== "1") {
      const bkFile = path.join(kdir, `${id}.board.json`);
      if (!fs.existsSync(bkFile)) {
        const kp = randomKeyPair();
        const r = await rpc.sendTx(full, id, [
          {
            type: "AddKey",
            publicKey: kp.publicKeyStr,
            permission: { receiverId: cfg.boardId, methodNames: ["post_offer", "cancel_offer"], allowance: ONE_NEAR / 4n },
          },
        ]);
        if (!r.ok) throw new Error(`board key ${id}: ${r.error}`);
        fs.writeFileSync(bkFile, JSON.stringify({ account_id: id, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr }), { mode: 0o600 });
        console.log(`board key for ${id} (${r.txHash})`);
      }
    }
  }
  console.log(`done: ${ids.length} accounts. Keys in ~/.near-credentials/testnet and ${kdir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
