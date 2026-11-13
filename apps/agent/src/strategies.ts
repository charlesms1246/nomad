// Scripted agent strategies (TECH_DOC §8). No LLM calls: the swarm runs deterministically from a seed.
// Each strategy looks at holdings and USD prices and returns the offers the agent wants live.

import type { Offer, TokenId } from "./protocol.js";

export type StrategyName = "spender" | "rebalancer" | "collector" | "random";

export interface TokenInfo {
  id: TokenId;
  symbol: string;
  decimals: number;
  priceUsd: number;
}

export interface StrategyCtx {
  agent: string;
  holdings: Record<TokenId, bigint>;
  tokens: TokenInfo[];
  /** Per-agent margin below mid price, 0..0.015 (TECH_DOC §8). */
  margin: number;
  rng: () => number;
  nowMs: number;
  ttlMs: number;
  /** Strategy parameters: target token for spender/collector, weights for rebalancer. */
  target?: TokenId;
  weights?: Record<TokenId, number>;
  /** Fraction of a holding offered at once. */
  sizeFrac?: number;
  nextId: () => string;
}

/** Deterministic PRNG (mulberry32). */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE_DEN = 10n ** 18n;

/**
 * Limit rate in smallest units: want units per give unit, at mid price times (1 - margin).
 * Returned as rateNum / rateDen with rateDen = 1e18 for precision.
 */
export function limitRate(give: TokenInfo, want: TokenInfo, margin: number): { rateNum: bigint; rateDen: bigint } {
  // 1 smallest give unit = priceGive / 10^decGive USD; in want smallest units: * 10^decWant / priceWant
  const human = (give.priceUsd / want.priceUsd) * (1 - margin);
  const decShift = want.decimals - give.decimals;
  // rate = human * 10^decShift; represent as num/den with den = 1e18
  const scaled = human * 1e9; // keep 9 significant fractional digits from the float
  let num = BigInt(Math.max(1, Math.round(scaled))) * 10n ** 9n; // num/den = human
  if (decShift >= 0) num *= 10n ** BigInt(decShift);
  else {
    const div = 10n ** BigInt(-decShift);
    // keep precision by scaling den instead of dividing num
    return { rateNum: num, rateDen: RATE_DEN * div };
  }
  return { rateNum: num, rateDen: RATE_DEN };
}

function offer(ctx: StrategyCtx, give: TokenInfo, want: TokenInfo, amt: bigint): Offer | null {
  if (amt <= 0n || give.id === want.id) return null;
  const r = limitRate(give, want, ctx.margin);
  return {
    id: ctx.nextId(),
    agent: ctx.agent,
    give: give.id,
    giveMax: amt,
    want: want.id,
    rateNum: r.rateNum,
    rateDen: r.rateDen,
    expiresAtMs: ctx.nowMs + ctx.ttlMs,
  };
}

const usd = (t: TokenInfo, amt: bigint) => (Number(amt) / 10 ** t.decimals) * t.priceUsd;
const frac = (amt: bigint, f: number) => (amt * BigInt(Math.round(f * 1e6))) / 1_000_000n;

export function runStrategy(name: StrategyName, ctx: StrategyCtx): Offer[] {
  const byId = new Map(ctx.tokens.map((t) => [t.id, t]));
  const held = ctx.tokens.filter((t) => (ctx.holdings[t.id] ?? 0n) > 0n);
  const size = ctx.sizeFrac ?? 0.5;
  if (held.length === 0) return [];

  switch (name) {
    case "spender": {
      // Needs `target` for a planned spend; gives its largest non-target holding.
      const target = byId.get(ctx.target ?? "") ?? ctx.tokens[0]!;
      const src = held.filter((t) => t.id !== target.id).sort((a, b) => usd(b, ctx.holdings[b.id]!) - usd(a, ctx.holdings[a.id]!))[0];
      if (!src) return [];
      const o = offer(ctx, src, target, frac(ctx.holdings[src.id]!, size));
      return o ? [o] : [];
    }
    case "collector": {
      // Accumulates one token: offers every other holding for it.
      const target = byId.get(ctx.target ?? "") ?? ctx.tokens[0]!;
      return held
        .filter((t) => t.id !== target.id)
        .map((t) => offer(ctx, t, target, frac(ctx.holdings[t.id]!, size)))
        .filter((o): o is Offer => o !== null);
    }
    case "rebalancer": {
      // Keeps target weights: sells the most overweight token for the most underweight one.
      const w = ctx.weights ?? Object.fromEntries(ctx.tokens.map((t) => [t.id, 1 / ctx.tokens.length]));
      const total = ctx.tokens.reduce((s, t) => s + usd(t, ctx.holdings[t.id] ?? 0n), 0);
      if (total <= 0) return [];
      const dev = ctx.tokens.map((t) => ({ t, d: usd(t, ctx.holdings[t.id] ?? 0n) / total - (w[t.id] ?? 0) }));
      dev.sort((a, b) => b.d - a.d);
      const over = dev[0]!, under = dev[dev.length - 1]!;
      if (over.d < 0.05 || under.d > -0.05) return [];
      const sellUsd = Math.min(over.d, -under.d) * total;
      const amt = BigInt(Math.floor((sellUsd / over.t.priceUsd) * 10 ** over.t.decimals));
      const o = offer(ctx, over.t, under.t, amt > ctx.holdings[over.t.id]! ? ctx.holdings[over.t.id]! : amt);
      return o ? [o] : [];
    }
    case "random": {
      const give = held[Math.floor(ctx.rng() * held.length)]!;
      const others = ctx.tokens.filter((t) => t.id !== give.id);
      const want = others[Math.floor(ctx.rng() * others.length)]!;
      const o = offer(ctx, give, want, frac(ctx.holdings[give.id]!, 0.2 + ctx.rng() * 0.6));
      return o ? [o] : [];
    }
  }
}
