import { describe, it, expect } from "vitest";
import { AgentRuntime, rngFrom, type TokenInfo } from "@nomad/agent";
import { findRings, type Ring } from "@nomad/ringfinder";
import { Matcher } from "../src/matcher.js";
import { InProcessLink } from "../src/inprocess.js";
import { LedgerChain } from "../src/ledger.js";
import { simSigner } from "../src/sim.js";

const W = "nep141:wnear", U = "nep141:usdc", Z = "nep141:zec";
const tokens: TokenInfo[] = [
  { id: W, symbol: "wNEAR", decimals: 24, priceUsd: 3.54 },
  { id: U, symbol: "USDC", decimals: 6, priceUsd: 1 },
  { id: Z, symbol: "ZEC", decimals: 8, priceUsd: 955 },
];

describe("consecutive races that reuse the same offers", () => {
  it("the second ring in a round still settles after the first one spent the offers' nonces", async () => {
    const chain = new LedgerChain("v", 1);
    const now = () => 1_000_000;
    const rng = rngFrom(3);
    const agents = new Map<string, AgentRuntime>();
    // a01 has a big offer; two small counterparties each close a separate 2-ring with it
    const plan: [string, string, string, bigint, number][] = [
      ["a01", W, U, 10n * 10n ** 24n, 0.5],
      ["a02", U, W, 3_000_000n, 1],
      ["a03", U, W, 3_000_000n, 1],
    ];
    for (const [id, hold, want, amt, frac] of plan) {
      chain.credit(id, hold, amt);
      agents.set(id, new AgentRuntime({ id, strategy: "spender", target: want, margin: 0.01, sizeFrac: frac, verifierId: "v" }, simSigner(id, rng), (ts) => chain.balances(id, ts), rngFrom(1)));
    }
    const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
    const link = new InProcessLink(agents, now);
    const ms = ["m1", "m2", "m3"].map((id) => new Matcher({ account: id, shard: null, now }, chain, simSigner(id, rng), link));
    const rings = findRings(offers, { feePips: 1, nowMs: now() });
    expect(rings.length).toBe(2);
    for (const m of ms) m.noteOffers(offers);
    const winners: string[] = [];
    for (const r of rings) {
      const res = await Promise.all(ms.map((m, i) => m.settle({ ...r, ringId: r.ringId + i } as Ring)));
      winners.push(res.filter((x) => x.status === "settled").map((x) => x.matcher).join(","));
    }
    expect(winners.every((w) => w.split(",").filter(Boolean).length === 1)).toBe(true);
  });
});

describe("a settlement the matcher could not confirm", () => {
  it("agents rotate the offer nonce after 'nonce was already used', so later rings still settle", async () => {
    const chain = new LedgerChain("v", 1);
    const now = () => 1_000_000;
    const rng = rngFrom(5);
    const agents = new Map<string, AgentRuntime>();
    for (const [id, hold, want] of [["a01", W, U], ["a02", U, W]] as const) {
      chain.credit(id, hold, hold === W ? 10n * 10n ** 24n : 30_000_000n);
      agents.set(id, new AgentRuntime({ id, strategy: "spender", target: want, margin: 0.01, sizeFrac: 0.2, verifierId: "v" }, simSigner(id, rng), (ts) => chain.balances(id, ts), rngFrom(1)));
    }
    const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
    // the chain executes, but the matcher sees a transport error (as with an RPC HANDLER_ERROR)
    const flaky = Object.create(chain) as LedgerChain;
    let first = true;
    flaky.execute = async (s, sub) => {
      const r = await chain.execute(s, sub);
      if (first) { first = false; return { ...r, ok: false, txHash: null, error: "rpc HANDLER_ERROR" }; }
      return r;
    };
    const m = new Matcher({ account: "m", shard: null, now }, flaky, simSigner("m", rng), new InProcessLink(agents, now));
    const [r1] = await m.round(offers);
    expect(r1!.status).toBe("failed"); // landed on chain, but unconfirmed
    const [r2] = await m.round(offers); // agents still sign with the spent nonce -> simulate fails, they rotate
    expect(r2!.error).toMatch(/nonce was already used/);
    const [r3] = await m.round(offers);
    expect(r3!.status).toBe("settled");
  });
});
