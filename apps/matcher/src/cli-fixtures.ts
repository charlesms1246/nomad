#!/usr/bin/env node
// make fixtures: sign demo rings (k = 3, 4, 5) from the funded testnet agents with long deadlines,
// so anyone can replay them with `make dry-run` (simulate_intents, no key). Fixtures hold signatures
// only, never keys; submitting one would only execute our own tiny demo ring.
import fs from "node:fs";
import path from "node:path";
import { sizeRing, diffsFor, netsToZero, type Offer } from "@nomad/ringfinder";
import { IntentsClient, signTokenDiff, TESTNET_RPC } from "@nomad/intents";
import { limitRate, type TokenInfo } from "@nomad/agent";
import { loadConfig, readKey, agentIds } from "./config.js";
import { SIM_TOKENS } from "./sim.js";

const dir = process.argv[2] ?? "fixtures/rings";
const DEADLINE = new Date(process.env.FIXTURE_DEADLINE ?? "2026-12-31T00:00:00Z"); // C5: no max deadline
const LEG_USD = +(process.env.LEG_USD ?? "0.25");

async function main() {
  const cfg = loadConfig();
  const client = new IntentsClient({ rpcUrl: cfg.rpcUrl ?? TESTNET_RPC, verifierId: cfg.verifierId });
  const fee = await client.fee();
  const salt = await client.currentSalt();
  const tok = (s: string): TokenInfo => {
    const t = cfg.tokens.find((x) => x.symbol === s);
    if (!t) throw new Error(`token ${s} not in config`);
    return { id: t.id, symbol: s, decimals: t.decimals, priceUsd: SIM_TOKENS.find((x) => x.symbol === s)!.priceUsd };
  };
  const cycles: Record<string, string[]> = {
    "ring-3": ["ZEC", "USDC", "wNEAR"],
    "ring-4": ["ZEC", "USDT", "USDC", "wNEAR"],
    "ring-5": ["BTC", "USDT", "USDC", "wNEAR", "ZEC"],
  };
  const agents = agentIds(12, cfg.parent);
  const matcher = cfg.matcherId ?? `intents-matcher.${cfg.parent}`;
  fs.mkdirSync(dir, { recursive: true });
  let start = 0;
  for (const [name, syms] of Object.entries(cycles)) {
    const ts = syms.map(tok);
    const who = agents.slice(start, start + ts.length);
    start = (start + ts.length) % agents.length;
    const offers: Offer[] = ts.map((t, i) => {
      const next = ts[(i + 1) % ts.length]!;
      const r = limitRate(t, next, 0.01);
      const giveMax = BigInt(Math.floor((LEG_USD / t.priceUsd) * 10 ** Math.min(t.decimals, 15))) * 10n ** BigInt(Math.max(0, t.decimals - 15));
      return { id: `fx-${name}-${i}`, agent: who[i]!, give: t.id, giveMax, want: next.id, rateNum: r.rateNum, rateDen: r.rateDen, expiresAtMs: DEADLINE.getTime() };
    });
    const sized = sizeRing(offers, { feePips: fee, phi: 0.2 });
    if (!sized) throw new Error(`${name}: no surplus`);
    const ring = { ...sized, ringId: name };
    const diffs = diffsFor(ring, matcher);
    if (!netsToZero(diffs, fee).ok) throw new Error(`${name}: does not net to zero`);
    const signed = diffs.map((d) => {
      const k = readKey(d.account, "intents");
      return signTokenDiff({ signerId: d.account, secretKey: k.secretKey, verifierId: cfg.verifierId, salt, deadline: DEADLINE, diff: d.diff, memo: `nomad:fixture:${name}` });
    });
    const sim = await client.simulate(signed);
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          name,
          note: "Signed NEP-413 token_diff legs of a demo ring on our testnet Verifier. Signatures only, no keys. Replay with `make dry-run`.",
          network: "testnet",
          verifierId: cfg.verifierId,
          createdAt: new Date().toISOString(),
          deadline: DEADLINE.toISOString(),
          feePips: fee,
          k: ring.k,
          surplusFactor: ring.surplusFactor,
          legs: ring.legs.map((l) => ({ ...l, giveAmt: l.giveAmt.toString(), getAmt: l.getAmt.toString() })),
          matcherLeg: { token: ring.matcherLeg.token, amt: ring.matcherLeg.amt.toString() },
          signed,
          simulatedAtCreation: { ok: sim.ok, intentsExecuted: sim.intentsExecuted?.length ?? 0, error: sim.error ?? null },
        },
        null,
        2,
      ),
    );
    console.log(`${file}: k=${ring.k} simulate ${sim.ok ? `OK, ${sim.intentsExecuted?.length} intents_executed` : `FAILED: ${sim.error}`}`);
  }

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
