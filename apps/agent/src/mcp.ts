#!/usr/bin/env node
// nomad-mcp: lets any MCP-capable agent framework join a Nomad market (IDEA §14 stretch 2).
// Tools:
//   nomad_tokens       tokens on the market (testnet ids, decimals)
//   nomad_balance      an agent's balances inside the Verifier
//   nomad_offer        post an offer on the board with the agent's board key ("give up to X of A, want >= rate of B")
//   nomad_cancel       cancel one of the agent's offers
//   nomad_status       the agent's live offers + rings it took part in (from the board's ring log)
//   nomad_leaderboard  matchers ranked by rings settled (board ring log)
// The tools post and read only. Signing ring legs stays with the agent runtime and its legCheck.
// Env: NOMAD_CONFIG (config/testnet.json), KEYS_DIR (./keys)
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IntentsClient, NearRpc, TESTNET_RPC } from "@nomad/intents";
import { BoardClient } from "./board.js";
import { limitRate } from "./strategies.js";

const cfg = JSON.parse(fs.readFileSync(process.env.NOMAD_CONFIG ?? path.resolve("config/testnet.json"), "utf8"));
const keysDir = process.env.KEYS_DIR ?? path.resolve("keys");
const boardId: string = cfg.boardId ?? `board.${cfg.parent ?? "nomadswarm.testnet"}`;
const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
const board = new BoardClient(rpc, boardId);
const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
const tokens: { symbol: string; id: string; decimals: number }[] = cfg.tokens;

const tok = (s: string) => {
  const t = tokens.find((x) => x.symbol.toLowerCase() === s.toLowerCase() || x.id === s);
  if (!t) throw new Error(`unknown token ${s}; one of ${tokens.map((x) => x.symbol).join(", ")}`);
  return t;
};
const boardKey = (agent: string) => {
  const k = JSON.parse(fs.readFileSync(path.join(keysDir, `${agent}.board.json`), "utf8"));
  return { signerId: agent, secretKey: k.private_key as string };
};
const human = (amt: bigint, dec: number) => (Number(amt) / 10 ** dec).toString();
const units = (x: number, dec: number) => BigInt(Math.floor(x * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12));
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `nomad: ${e instanceof Error ? e.message : String(e)}` }] });
const wrap = <A>(f: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return ok(await f(a));
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer({ name: "nomad", version: "0.1.0" });

server.registerTool("nomad_tokens", { description: "List the tokens traded on this Nomad market.", inputSchema: {} }, wrap(async () => tokens));

server.registerTool(
  "nomad_balance",
  { description: "An agent's token balances inside the Intents Verifier.", inputSchema: { agent: z.string() } },
  wrap(async ({ agent }: { agent: string }) => {
    const v = await intents.mtBatchBalanceOf(agent, tokens.map((t) => t.id));
    return Object.fromEntries(tokens.map((t, i) => [t.symbol, human(v[i] ?? 0n, t.decimals)]));
  }),
);

server.registerTool(
  "nomad_offer",
  {
    description:
      "Post an offer: the agent gives up to `giveAmount` of `give` and wants at least `minRate` units of `want` per unit of `give` (human units). Matchers may include it in a ring; the agent still checks and signs its own leg.",
    inputSchema: {
      agent: z.string().describe("agent account, e.g. a05.nomadswarm.testnet (its board key must be in KEYS_DIR)"),
      give: z.string().describe("token symbol, e.g. USDC"),
      giveAmount: z.number().positive(),
      want: z.string().describe("token symbol, e.g. wNEAR"),
      minRate: z.number().positive().describe("minimum `want` per 1 `give`, human units"),
      ttlMinutes: z.number().positive().max(60).default(10),
    },
  },
  wrap(async (a: { agent: string; give: string; giveAmount: number; want: string; minRate: number; ttlMinutes: number }) => {
    const g = tok(a.give), w = tok(a.want);
    // reuse the strategy's rate encoding: price ratio = minRate, margin 0
    const r = limitRate({ ...g, priceUsd: a.minRate }, { ...w, priceUsd: 1 }, 0);
    const id = await board.postOffer(boardKey(a.agent), { give: g.id, giveMax: units(a.giveAmount, g.decimals), want: w.id, rateNum: r.rateNum, rateDen: r.rateDen }, a.ttlMinutes * 60_000);
    return { offerId: id, board: boardId };
  }),
);

server.registerTool(
  "nomad_cancel",
  { description: "Cancel one of the agent's offers.", inputSchema: { agent: z.string(), offerId: z.string() } },
  wrap(async ({ agent, offerId }: { agent: string; offerId: string }) => {
    const r = await board.cancelOffer(boardKey(agent), offerId);
    return { ok: r.ok, tx: r.txHash, error: r.error };
  }),
);

interface RingRecord { seq: number; ring_id: string; offer_ids: number[]; tx_hash: string; matcher: string; recorded_at_ms: number }
const allRings = async () => {
  const out: RingRecord[] = [];
  for (let from = 0; ; from += 100) {
    const page = await rpc.view<RingRecord[]>(boardId, "rings", { from, limit: 100 });
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
};

server.registerTool(
  "nomad_status",
  { description: "An agent's live offers and the rings (tx hashes) its offers were settled in.", inputSchema: { agent: z.string() } },
  wrap(async ({ agent }: { agent: string }) => {
    const offers = await board.offersByAgent(agent);
    const rings = await allRings();
    const mine = await Promise.all(
      rings.map(async (r) => {
        for (const id of r.offer_ids) {
          const o = await rpc.view<{ agent: string } | null>(boardId, "get_offer", { id });
          if (o?.agent === agent) return r;
        }
        return null;
      }),
    );
    return {
      offers: offers.map((o) => ({ id: o.id, give: tokens.find((t) => t.id === o.give)?.symbol, giveMax: o.giveMax, want: tokens.find((t) => t.id === o.want)?.symbol, expiresAt: new Date(o.expiresAtMs).toISOString() })),
      rings: mine.filter(Boolean),
    };
  }),
);

server.registerTool(
  "nomad_leaderboard",
  { description: "Matchers ranked by rings settled, from the board's ring log. Anyone can run a matcher.", inputSchema: {} },
  wrap(async () => {
    const counts = new Map<string, number>();
    for (const r of await allRings()) counts.set(r.matcher, (counts.get(r.matcher) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([matcher, rings]) => ({ matcher, rings }));
  }),
);

await server.connect(new StdioServerTransport());
