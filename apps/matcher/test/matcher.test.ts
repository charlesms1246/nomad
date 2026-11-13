import { describe, it, expect } from "vitest";
import { AgentRuntime, rngFrom, type MultiPayload, type TokenInfo } from "@nomad/agent";
import { feeOf } from "@nomad/ringfinder";
import { Matcher } from "../src/matcher.js";
import { InProcessLink } from "../src/inprocess.js";
import type { Chain } from "../src/chain.js";

// Test-only ledger: applies token_diffs with the Verifier's fee rule and per-token zero-sum check.
// (The real model with signature/nonce checks lives in @nomad/verifier-model.)
class FakeChain implements Chain {
  verifierId = "intents.nomadswarm.testnet";
  network = "sim" as const;
  bal = new Map<string, bigint>();
  executed: MultiPayload[][] = [];
  constructor(public fee = 1) {}
  async feePips() { return this.fee; }
  async salt() { return "252812b3"; }
  async balances(a: string, tokens: string[]) {
    return Object.fromEntries(tokens.map((t) => [t, this.bal.get(`${a}|${t}`) ?? 0n]));
  }
  private apply(signed: MultiPayload[], commit: boolean) {
    const next = new Map(this.bal);
    const net: Record<string, bigint> = {};
    for (const s of signed) {
      const m = JSON.parse(s.payload.message);
      for (const it of m.intents)
        for (const [t, v] of Object.entries(it.diff as Record<string, string>)) {
          const d = BigInt(v), k = `${m.signer_id}|${t}`;
          const nb = (next.get(k) ?? 0n) + d;
          if (nb < 0n) return { ok: false, error: "insufficient balance or overflow" };
          next.set(k, nb);
          net[t] = (net[t] ?? 0n) + (d < 0n ? d + feeOf(-d, this.fee) : d);
        }
    }
    if (Object.values(net).some((v) => v !== 0n)) return { ok: false, error: "UnmatchedDeltas" };
    if (commit) this.bal = next;
    return { ok: true };
  }
  async simulate(s: MultiPayload[]) { return this.apply(s, false); }
  async execute(s: MultiPayload[]) {
    const r = this.apply(s, true);
    if (r.ok) this.executed.push(s);
    return { ...r, txHash: r.ok ? `tx${this.executed.length}` : null, blockHeight: 1, blocksToExec: 0, gasBurntTgas: 10 };
  }
}

const W = "nep141:wnear", U = "nep141:usdc", Z = "nep141:zec";
const tokens: TokenInfo[] = [
  { id: W, symbol: "wNEAR", decimals: 24, priceUsd: 3.54 },
  { id: U, symbol: "USDC", decimals: 6, priceUsd: 1 },
  { id: Z, symbol: "ZEC", decimals: 8, priceUsd: 955 },
];
const fakeSigner = (account: string) => (a: { diff: Record<string, string>; deadline: Date; salt: string }) => ({
  standard: "nep413" as const,
  payload: { message: JSON.stringify({ signer_id: account, deadline: a.deadline.toISOString(), intents: [{ intent: "token_diff", diff: a.diff }] }), nonce: "", recipient: "intents.nomadswarm.testnet" },
  public_key: "ed25519:x",
  signature: "ed25519:y",
});

function setup(fee = 1) {
  const chain = new FakeChain(fee);
  const now = () => 1_000_000;
  const mk = (id: string, target: string, holding: [string, bigint]) => {
    chain.bal.set(`${id}|${holding[0]}`, holding[1]);
    return new AgentRuntime(
      { id, strategy: "spender", target, margin: 0.01, sizeFrac: 0.5, verifierId: chain.verifierId },
      fakeSigner(id),
      (ts) => chain.balances(id, ts),
      rngFrom(1),
    );
  };
  // a01 has wNEAR wants USDC; a02 has USDC wants ZEC; a03 has ZEC wants wNEAR -> a 3-ring, no pair
  const agents = new Map([
    ["a01", mk("a01", U, [W, 2n * 10n ** 24n])],
    ["a02", mk("a02", Z, [U, 10_000_000n])],
    ["a03", mk("a03", W, [Z, 1_000_000n])],
  ]);
  const m = new Matcher(
    { account: "intents-matcher.nomadswarm.testnet", shard: 7, now, priceUsd: Object.fromEntries(tokens.map((t) => [t.id, t.priceUsd])), decimals: Object.fromEntries(tokens.map((t) => [t.id, t.decimals])) },
    chain,
    fakeSigner("intents-matcher.nomadswarm.testnet"),
    new InProcessLink(agents, now),
  );
  return { chain, agents, m, now };
}

describe("matcher end to end (in-process, fake ledger)", () => {
  it("settles a 3-ring in one execute and every agent gets at least its limit", async () => {
    const { chain, agents, m, now } = setup();
    const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
    expect(offers).toHaveLength(3);
    const rings = await m.round(offers);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.status).toBe("settled");
    expect(rings[0]!.k).toBe(3);
    expect(chain.executed).toHaveLength(1);
    expect(chain.executed[0]!.length).toBe(4); // 3 agents + matcher
    expect(rings[0]!.signedBy.sort()).toEqual(["a01", "a02", "a03"]);
    // balances moved
    expect(chain.bal.get(`a01|${U}`)! > 0n).toBe(true);
    expect(chain.bal.get(`a02|${Z}`)! > 0n).toBe(true);
    expect(chain.bal.get(`a03|${W}`)! > 0n).toBe(true);
    expect((chain.bal.get(`intents-matcher.nomadswarm.testnet|${rings[0]!.matcherLeg.token}`) ?? 0n) > 0n).toBe(true);
  });

  it("fails the whole ring and moves nothing when an agent spent its balance first", async () => {
    const { chain, agents, m, now } = setup();
    const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
    // a02 spends its USDC elsewhere after posting but the agent's cached balance is stale
    chain.bal.set(`a02|${U}`, 1n);
    const before = new Map(chain.bal);
    const rings = await m.round(offers);
    expect(rings[0]!.status).toBe("failed");
    expect(rings[0]!.error).toMatch(/insufficient balance/);
    expect(chain.bal).toEqual(before);
  });

  it("an agent declines a leg below its limit, so nothing is submitted", async () => {
    const { chain, agents, m, now } = setup();
    const offers = (await Promise.all([...agents.values()].map((a) => a.refresh(tokens, now())))).flat();
    // tamper: matcher proposes using an offer list where a01's limit was faked lower than its real one
    const tampered = offers.map((o) => (o.agent === "a01" ? { ...o, rateNum: o.rateNum / 2n } : o));
    const rings = await m.round(tampered);
    expect(rings[0]!.status).toBe("failed");
    expect(rings[0]!.error).toMatch(/a01 \(rate below limit\)/);
    expect(chain.executed).toHaveLength(0);
  });
});
