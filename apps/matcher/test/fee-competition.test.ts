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

async function setup(auctionMs: number) {
  const chain = new LedgerChain("v", 1);
  const now = () => 1_000_000;
  const rng = rngFrom(9);
  const agents = new Map<string, AgentRuntime>();
  for (const [id, hold, want, amt] of [["a01", W, U, 10n ** 25n], ["a02", U, Z, 50_000_000n], ["a03", Z, W, 5_000_000n]] as const) {
    chain.credit(id, hold, amt);
    agents.set(
      id,
      new AgentRuntime(
        { id, strategy: "spender", target: want, margin: 0.02, sizeFrac: 0.3, verifierId: "v", auctionMs },
        simSigner(id, rng),
        (ts) => chain.balances(id, ts),
        rngFrom(1),
      ),
    );
  }
  const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
  const link = new InProcessLink(agents, now);
  const mk = (id: string, phi: number) => {
    const m = new Matcher({ account: id, shard: null, now, phi }, chain, simSigner(id, rng), link);
    m.noteOffers(offers);
    return m;
  };
  const ringFor = (phi: number, tag: string) => ({ ...(findRings(offers, { feePips: 1, nowMs: now(), phi })[0] as Ring), ringId: tag });
  return { chain, mk, ringFor };
}

describe("matchers compete on fee", () => {
  it("with an auction window, the cheaper matcher wins even when the expensive one proposes first", async () => {
    const { chain, mk, ringFor } = await setup(50);
    const pricey = mk("pricey", 0.5), cheap = mk("cheap", 0.05);
    // pricey starts first; both proposals land in each agent's 50 ms window
    const [p, c] = await Promise.all([pricey.settle(ringFor(0.5, "p")), cheap.settle(ringFor(0.05, "c"))]);
    expect(c.status).toBe("settled");
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/outbid by a cheaper matcher/);
    expect(chain.txs).toBe(1);
    expect(c.matcherShareBps).toBeLessThan(p.matcherShareBps);
  });

  it("without a window, a strictly worse proposal that arrives after a better one is declined", async () => {
    const { chain, mk, ringFor } = await setup(0);
    const cheap = mk("cheap", 0.05), pricey = mk("pricey", 0.5);
    const [c, p] = await Promise.all([cheap.settle(ringFor(0.05, "c")), pricey.settle(ringFor(0.5, "p"))]);
    expect(c.status).toBe("settled");
    expect(p.error).toMatch(/better proposal already signed/);
    expect(chain.txs).toBe(1);
  });
});
