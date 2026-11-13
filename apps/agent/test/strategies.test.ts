import { describe, it, expect } from "vitest";
import { limitRate, runStrategy, rngFrom, type TokenInfo } from "../src/strategies.js";

const W: TokenInfo = { id: "W", symbol: "wNEAR", decimals: 24, priceUsd: 3.54 };
const U: TokenInfo = { id: "U", symbol: "USDC", decimals: 6, priceUsd: 1 };
const Z: TokenInfo = { id: "Z", symbol: "ZEC", decimals: 8, priceUsd: 955 };

describe("limitRate", () => {
  it("prices wNEAR->USDC in smallest units", () => {
    const r = limitRate(W, U, 0);
    // 1 wNEAR (1e24) should be worth ~3.54e6 USDC units
    const out = (10n ** 24n * r.rateNum) / r.rateDen;
    expect(Number(out)).toBeCloseTo(3_540_000, -1);
  });
  it("prices USDC->wNEAR (decimals up)", () => {
    const r = limitRate(U, W, 0);
    const out = (10n ** 6n * r.rateNum) / r.rateDen;
    expect(Number(out) / 1e24).toBeCloseTo(1 / 3.54, 6);
  });
  it("applies the margin", () => {
    const a = limitRate(U, Z, 0), b = limitRate(U, Z, 0.01);
    expect(Number(b.rateNum * a.rateDen) / Number(a.rateNum * b.rateDen)).toBeCloseTo(0.99, 6);
  });
});

describe("strategies", () => {
  const base = {
    agent: "a01", tokens: [W, U, Z], margin: 0.005, rng: rngFrom(1), nowMs: 0, ttlMs: 60_000,
    nextId: (() => { let i = 0; return () => String(i++); })(),
  };
  it("spender gives its largest holding for its target", () => {
    const o = runStrategy("spender", { ...base, target: "U", holdings: { W: 10n ** 24n, Z: 1n, U: 0n } });
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ give: "W", want: "U" });
  });
  it("collector offers every other token", () => {
    const o = runStrategy("collector", { ...base, target: "Z", holdings: { W: 10n ** 24n, U: 10n ** 6n } });
    expect(o.map((x) => x.give).sort()).toEqual(["U", "W"]);
  });
  it("rebalancer sells overweight for underweight", () => {
    const o = runStrategy("rebalancer", { ...base, holdings: { W: 10n ** 25n, U: 0n, Z: 0n } });
    expect(o[0]?.give).toBe("W");
  });
  it("random is deterministic per seed", () => {
    const h = { W: 10n ** 24n, U: 10n ** 6n };
    const a = runStrategy("random", { ...base, rng: rngFrom(7), holdings: h });
    const b = runStrategy("random", { ...base, rng: rngFrom(7), holdings: h });
    expect(a.map((x) => [x.give, x.want, x.giveMax])).toEqual(b.map((x) => [x.give, x.want, x.giveMax]));
  });
});
