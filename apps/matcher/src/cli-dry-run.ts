#!/usr/bin/env node
// make dry-run: replay the committed signed demo rings with simulate_intents on our testnet Verifier.
// A view call: no key, no deposit, nothing is sent. Also prints the matcher's shard placement and
// a live 1Click baseline (mainnet dry quote, read-only).
import fs from "node:fs";
import path from "node:path";
import { IntentsClient, TESTNET_RPC } from "@nomad/intents";
import { check } from "@nomad/colo";
import { dryQuote } from "@nomad/oneclick";
import { loadConfig } from "./config.js";

async function main() {
  const dir = process.argv[2] ?? "fixtures/rings";
  const cfg = loadConfig();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (files.length === 0) {
    console.log(`no fixtures in ${dir}; run \`make fixtures\` first`);
    process.exit(1);
  }
  let failures = 0;
  for (const f of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const client = new IntentsClient({ rpcUrl: cfg.rpcUrl ?? TESTNET_RPC, verifierId: fx.verifierId ?? cfg.verifierId });
    const r = await client.simulate(fx.signed);
    const legs = (fx.legs as { agent: string; give: string; giveAmt: string; get: string; getAmt: string }[])
      .map((l) => `${l.agent.split(".")[0]} -${l.giveAmt} ${short(l.give)} +${l.getAmt} ${short(l.get)}`)
      .join(" | ");
    if (r.ok) {
      console.log(`${f}: simulate_intents on ${client.verifierId}: ${r.intentsExecuted?.length} intents_executed (${fx.k} agents + matcher)`);
      console.log(`  legs: ${legs}`);
      const balanceLogs = (r.logs ?? []).filter((l) => l.includes("token_diff")).length;
      console.log(`  ${balanceLogs} token_diff events, fee ${r.state?.fee} pips, salt ${r.state?.current_salt}`);
    } else if (r.errorClass === "nonce was already used") {
      console.log(`${f}: already executed on chain (its nonces are used). Run \`make fixtures\` to sign fresh ones.`);
    } else {
      failures++;
      console.log(`${f}: simulate FAILED: ${r.errorClass ?? ""} ${r.error ?? ""}`);
    }
  }
  const matcher = cfg.matcherId ?? `intents-matcher.${cfg.parent}`;
  const c = await check({ account: matcher, target: cfg.verifierId }, { network: "testnet" });
  console.log(`colo: ${matcher} on shard ${c.accountShard}, ${cfg.verifierId} on shard ${c.targetShard} => ${c.colocated ? "same shard" : "DIFFERENT shard"}`);
  try {
    const q = await dryQuote({ originAsset: "nep141:wrap.near", destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: 10n ** 24n });
    console.log(`1Click baseline (mainnet dry quote, read-only) at ${q.timestamp}: 1 wNEAR -> ${Number(q.amountOut) / 1e6} USDC, app fee ${q.appFees.map((x) => x.fee).join("+") || 0} bps`);
  } catch (e) {
    console.log(`1Click baseline unavailable: ${String(e).slice(0, 120)}`);
  }
  process.exit(failures ? 1 : 0);
}

const short = (t: string) => t.replace(/^nep141:/, "").split(".")[0];

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
