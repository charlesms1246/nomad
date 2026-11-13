import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { findRings, diffsFor, netsToZero, feeOf, grossFor, sizeRing, type Offer } from "../src/index.js";

const W = "nep141:wnear", U = "nep141:usdc", Z = "nep141:zec", T = "nep141:usdt", B = "nep141:btc";
const DEC: Record<string, number> = { [W]: 24, [U]: 6, [Z]: 8, [T]: 6, [B]: 8 };
const PX: Record<string, number> = { [W]: 3.54, [U]: 1, [Z]: 955, [T]: 1, [B]: 68866 };
const NOW = 1_000_000;
const FEE = 1; // pips, as measured

/** rate in smallest units from a human rate (want per give). */
const rate = (give: string, want: string, human: number) => {
  const num = BigInt(Math.round(human * 1e12)) * 10n ** BigInt(Math.max(0, DEC[want]! - DEC[give]!));
  const den = 10n ** 12n * 10n ** BigInt(Math.max(0, DEC[give]! - DEC[want]!));
  return { rateNum: num, rateDen: den };
};
const offer = (id: string, agent: string, give: string, want: string, human: number, giveHuman: number): Offer => ({
  id, agent, give, want, ...rate(give, want, human),
  giveMax: BigInt(Math.round(giveHuman * 1e6)) * 10n ** BigInt(DEC[give]! - 6),
  expiresAtMs: NOW + 60_000,
});

/** Every ring must satisfy the RULES: limits, capacities, distinct agents, cycle, zero-sum after fees. */
function assertValid(rings: ReturnType<typeof findRings>, offers: Offer[], fee = FEE) {
  const used = new Map<string, bigint>();
  for (const r of rings) {
    expect(r.k).toBe(r.legs.length);
    expect(r.k).toBeGreaterThanOrEqual(2);
    expect(r.k).toBeLessThanOrEqual(5);
    expect(new Set(r.legs.map((l) => l.agent)).size).toBe(r.k);
    expect(r.surplusFactor).toBeGreaterThan(1);
    expect(r.matcherLeg.amt >= 0n).toBe(true);
    r.legs.forEach((l, i) => {
      const o = offers.find((x) => x.id === l.offerId)!;
      expect(l.give).toBe(o.give);
      expect(l.get).toBe(o.want);
      expect(l.get).toBe(r.legs[(i + 1) % r.k]!.give);
      expect(l.getAmt * o.rateDen >= l.giveAmt * o.rateNum).toBe(true); // at or above limit
      used.set(o.id, (used.get(o.id) ?? 0n) + l.giveAmt);
    });
    const z = netsToZero(diffsFor(r, "matcher"), fee);
    expect(z.ok, JSON.stringify(z.residual, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
  }
  for (const [id, amt] of used) expect(amt <= offers.find((o) => o.id === id)!.giveMax).toBe(true);
}

describe("fee helpers", () => {
  it("feeOf is a ceiling", () => {
    expect(feeOf(1000n, 1)).toBe(1n);
    expect(feeOf(4969498n, 1)).toBe(5n); // matches mainnet tx 86bq2z...
    expect(feeOf(4970000000000000000n, 1)).toBe(4970000000000n);
  });
  it("grossFor is minimal", () => {
    for (const y of [1n, 999n, 1000n, 999_999n, 10n ** 24n]) {
      const x = grossFor(y, 1);
      expect(x - feeOf(x, 1) >= y).toBe(true);
      expect(x - 1n - feeOf(x - 1n, 1) < y).toBe(true);
    }
  });
  it("an exact zero-sum pair fails, receiver must get less", () => {
    expect(netsToZero([{ account: "a", diff: { X: "-1000" } }, { account: "b", diff: { X: "1000" } }], 1).ok).toBe(false);
    expect(netsToZero([{ account: "a", diff: { X: "-1000" } }, { account: "b", diff: { X: "999" } }], 1).ok).toBe(true);
  });
});

describe("worked example (TECH_DOC §5.5)", () => {
  const offers = [
    offer("1", "a01", W, U, 3.5, 2),
    offer("2", "a02", U, Z, 0.00104, 7),
    offer("3", "a03", Z, W, 268, 0.01),
  ];
  it("finds the 3-ring with ~2.5% surplus", () => {
    const rings = findRings(offers, { feePips: FEE, nowMs: NOW, priceUsd: PX, decimals: DEC });
    expect(rings).toHaveLength(1);
    expect(rings[0]!.k).toBe(3);
    expect(rings[0]!.surplusFactor).toBeCloseTo(1.0251, 3);
    assertValid(rings, offers);
  });
  it("closes on the highest-value-per-unit token (ZEC)", () => {
    const r = findRings(offers, { feePips: FEE, nowMs: NOW, priceUsd: PX, decimals: DEC })[0]!;
    expect(r.matcherLeg.token).toBe(Z);
  });
  it("agents get better than their limit (g > 1)", () => {
    const r = findRings(offers, { feePips: FEE, nowMs: NOW })[0]!;
    for (const l of r.legs) {
      const o = offers.find((x) => x.id === l.offerId)!;
      expect(Number(l.getAmt * o.rateDen) / Number(l.giveAmt * o.rateNum)).toBeGreaterThan(1.004);
    }
  });
});

describe("no ring", () => {
  it("returns nothing when the product of rates is above 1", () => {
    const offers = [offer("1", "a", W, U, 3.6, 1), offer("2", "b", U, W, 0.29, 5)]; // 3.6*0.29 = 1.044
    expect(findRings(offers, { feePips: FEE, nowMs: NOW })).toEqual([]);
  });
  it("ignores expired offers", () => {
    const offers = [offer("1", "a", W, U, 3.5, 1), { ...offer("2", "b", U, W, 0.28, 5), expiresAtMs: NOW - 1 }];
    expect(findRings(offers, { feePips: FEE, nowMs: NOW })).toEqual([]);
  });
  it("needs distinct agents", () => {
    const offers = [offer("1", "a", W, U, 3.5, 1), offer("2", "a", U, W, 0.28, 5)];
    expect(findRings(offers, { feePips: FEE, nowMs: NOW })).toEqual([]);
  });
  it("a pair exactly at fee-break-even does not clear", () => {
    const o = [
      { id: "1", agent: "a", give: "X", want: "Y", giveMax: 10n ** 9n, rateNum: 1n, rateDen: 1n, expiresAtMs: NOW + 1 },
      { id: "2", agent: "b", give: "Y", want: "X", giveMax: 10n ** 9n, rateNum: 1n, rateDen: 1n, expiresAtMs: NOW + 1 },
    ];
    expect(sizeRing(o, { feePips: FEE })).toBeNull();
  });
});

describe("dust remainders", () => {
  it("a nearly-filled best-rate offer does not block the rest of its edge", () => {
    const offers = [
      offer("a", "a1", W, U, 3.50, 1.0), // best rate on W->U, filled to dust by c
      offer("b", "a2", W, U, 3.51, 1.0),
      offer("c", "a3", U, W, 0.2845, 3.5 * 0.99995), // takes almost all of a
      offer("d", "a4", U, W, 0.2845, 3.5),
    ];
    const rings = findRings(offers, { feePips: FEE, nowMs: NOW, priceUsd: PX, decimals: DEC });
    expect(rings).toHaveLength(2);
    assertValid(rings, offers);
  });
});

describe("k = 2..5", () => {
  it("finds a 5-ring when only the full loop clears", () => {
    const offers = [
      offer("1", "a1", W, U, 3.5, 2),
      offer("2", "a2", U, T, 0.995, 10),
      offer("3", "a3", T, B, 0.0000144, 10),
      offer("4", "a4", B, Z, 71.5, 0.001),
      offer("5", "a5", Z, W, 268, 0.05),
    ];
    const rings = findRings(offers, { feePips: FEE, nowMs: NOW, priceUsd: PX, decimals: DEC });
    expect(rings.map((r) => r.k)).toEqual([5]);
    assertValid(rings, offers);
  });
});

describe("property: random offer books", () => {
  const tokens = [W, U, Z, T, B];
  const arbOffer = fc.record({
    agent: fc.integer({ min: 0, max: 19 }),
    give: fc.integer({ min: 0, max: 4 }),
    want: fc.integer({ min: 0, max: 4 }),
    margin: fc.double({ min: -0.01, max: 0.03, noNaN: true }),
    usd: fc.double({ min: 0.5, max: 5, noNaN: true }),
  });
  it("every ring found is valid (limits, capacities, zero-sum after fees)", () => {
    fc.assert(
      fc.property(fc.array(arbOffer, { minLength: 2, maxLength: 40 }), fc.integer({ min: 0, max: 100 }), (raw, fee) => {
        const offers: Offer[] = raw
          .filter((r) => r.give !== r.want)
          .map((r, i) => {
            const g = tokens[r.give]!, w = tokens[r.want]!;
            const human = (PX[g]! / PX[w]!) * (1 - r.margin);
            return offer(String(i), `a${r.agent}`, g, w, human, r.usd / PX[g]!);
          });
        const rings = findRings(offers, { feePips: fee, nowMs: NOW, priceUsd: PX, decimals: DEC, minGiveUnits: 1n });
        assertValid(rings, offers, fee);
      }),
      { numRuns: 300 },
    );
  });
});
