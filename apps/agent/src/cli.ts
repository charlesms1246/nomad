#!/usr/bin/env node
// A standalone Nomad agent process: joins a matcher's bus over WebSocket (TECH_DOC §6.2),
// posts its offers to the board, and signs only legs that pass legCheck.
//   AGENT=a05.nomadswarm.testnet MATCHER_WS=ws://localhost:8787/ws STRATEGY=spender TARGET=nep141:usdc...
//   LLM=1 NEARAI_API_KEY=... PLAN="..."   (optional: NEAR AI Cloud sets the margin)
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { NearRpc, signTokenDiff, IntentsClient, TESTNET_RPC } from "@nomad/intents";
import { AgentRuntime } from "./runtime.js";
import { rngFrom, type StrategyName, type TokenInfo } from "./strategies.js";
import { BoardClient } from "./board.js";
import { fromWireProposal, toWireOffer, type BusMessage } from "./protocol.js";
import { llmMarginAdvisor } from "./llm.js";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`set ${k}`);
  return v;
};

async function main() {
  const id = env("AGENT");
  const keysDir = env("KEYS_DIR", path.resolve("keys"));
  const cfgFile = env("NOMAD_CONFIG", path.resolve("config/testnet.json"));
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  const key = (kind: string) => JSON.parse(fs.readFileSync(path.join(keysDir, `${id}.${kind}.json`), "utf8"));
  const ik = key("intents"), bk = key("board");
  const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
  const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
  const board = new BoardClient(rpc, cfg.boardId);
  const tokens: TokenInfo[] = cfg.tokens.map((t: any) => ({ id: t.id, symbol: t.symbol, decimals: t.decimals, priceUsd: t.priceUsd ?? 1 }));

  const agent = new AgentRuntime(
    {
      id,
      strategy: env("STRATEGY", "spender") as StrategyName,
      target: process.env.TARGET,
      margin: +env("MARGIN", "0.008"),
      verifierId: cfg.verifierId,
      ttlMs: 10 * 60_000,
      marginAdvisor:
        process.env.LLM === "1"
          ? llmMarginAdvisor({ apiKey: env("NEARAI_API_KEY"), plan: env("PLAN", "I need the target token for inference; I can wait for a fair rate.") })
          : undefined,
    },
    (a) => signTokenDiff({ signerId: id, secretKey: ik.private_key, verifierId: a.verifierId, salt: a.salt, deadline: a.deadline, diff: a.diff, memo: a.memo, nonce: a.nonce }) as never,
    async (ts) => Object.fromEntries((await intents.mtBatchBalanceOf(id, ts)).map((v, i) => [ts[i]!, v])),
    rngFrom(Number(process.env.SEED ?? 1)),
  );

  const ws = new WebSocket(env("MATCHER_WS", "ws://localhost:8787/ws"));
  const send = (m: BusMessage) => ws.send(JSON.stringify(m, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const posted = new Set<string>();

  const refresh = async () => {
    const offers = await agent.refresh(tokens, Date.now());
    for (const o of offers) {
      if (posted.has(o.id)) continue;
      o.id = await board.postOffer({ signerId: id, secretKey: bk.private_key }, o, agent.cfg.ttlMs!);
      posted.add(o.id);
      console.log(`posted offer ${o.id}: ${o.giveMax} ${o.give} -> ${o.want}`);
    }
    send({ type: "OFFERS", agent: id, offers: agent.offers.map(toWireOffer) });
  };

  ws.on("open", async () => {
    console.log(`${id} connected`);
    send({ type: "HELLO", agent: id, offers: [] });
    await refresh();
    setInterval(() => refresh().catch((e) => console.error("refresh", String(e))), 20_000);
  });
  ws.on("message", (raw) => {
    const m: BusMessage = JSON.parse(raw.toString());
    if (m.type === "PROPOSE" && m.to === id) {
      const ans = agent.onProposal(fromWireProposal(m.proposal), Date.now());
      console.log(`${m.proposal.ringId.slice(0, 12)}: ${ans.type}${ans.type === "DECLINE" ? ` (${ans.reason})` : ""}`);
      send(ans);
    } else if (m.type === "SETTLED") {
      agent.onSettled(m.ringId);
      console.log(`settled ${m.ringId.slice(0, 12)} tx ${m.txHash}`);
    } else if (m.type === "FAILED") {
      agent.onFailed(m.ringId);
    }
  });
  ws.on("close", () => process.exit(0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
