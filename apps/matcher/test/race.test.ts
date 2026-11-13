import { describe, it, expect } from "vitest";
import { AgentRuntime, rngFrom, type TokenInfo } from "@nomad/agent";
import { findRings } from "@nomad/ringfinder";
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

describe("two matchers race for the same ring", () => {
  it("only one settles, even though every agent holds enough for both (shared per-offer nonce)", async () => {
    const chain = new LedgerChain("intents.nomadswarm.testnet", 1);
    const now = () => 1_000_000;
    const rng = rngFrom(3);
    const agents = new Map<string, AgentRuntime>();
    const plan: [string, string, string, bigint][] = [
      ["a01", W, U, 10n * 10n ** 24n],
      ["a02", U, Z, 100_000_000n],
      ["a03", Z, W, 10_000_000n],
    ];
    for (const [id, hold, want, amt] of plan) {
      chain.credit(id, hold, amt);
      // offers use only 20% of the balance, so balance alone would let both rings settle
      agents.set(id, new AgentRuntime({ id, strategy: "spender", target: want, margin: 0.01, sizeFrac: 0.2, verifierId: chain.verifierId }, simSigner(id, rng), (ts) => chain.balances(id, ts), rngFrom(1)));
    }
    const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
    const link = new InProcessLink(agents, now);
    const mk = (id: string) => new Matcher({ account: id, shard: null, now }, chain, simSigner(id, rng), link);
    const m1 = mk("intents-matcher.nomadswarm.testnet"), m2 = mk("matcher.nomadswarm.testnet");
    const [ring] = findRings(offers, { feePips: 1, nowMs: now() });
    expect(ring).toBeDefined();
    // concurrent: both collect signatures before either submits (the real race)
    const [a, b] = await Promise.all([m1.settle(ring!), m2.settle({ ...ring!, ringId: ring!.ringId + "b" })]);
    expect(a.status).toBe("settled");
    expect(b.status).toBe("failed");
    expect(b.error).toMatch(/nonce was already used/);
    expect(chain.txs).toBe(1);
  });
});
