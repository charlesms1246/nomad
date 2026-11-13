// Ring finding, sizing and surplus split (TECH_DOC §5, corrected by BUILD_PLAN C1).
//
// Offers are edges give -> want with limit rate rho = rateNum / rateDen (smallest want units per
// smallest give unit). A cycle o_1..o_k (want(o_i) = give(o_{i+1})) can settle when
//   S = prod(1 - fee) / prod(rho_i) > 1
// because the Verifier takes fee = ceil(|d| * feePips / 1e6) from every negative delta.
// Agent i gives x_i of T_i and receives y_i of T_{i+1}:
//   y_i = x_{i+1} - fee(x_{i+1})            for i < k   (token T_{i+1} nets to zero)
//   y_k + m = x_1 - fee(x_1)                (closing token T_1; m = matcher's positive-only diff)
//   y_i >= ceil(rho_i * x_i)                (every agent at or above its limit)
// Each agent's limit is improved by g = S^((1-phi)/k); the matcher keeps about S^phi.

import { createHash } from "node:crypto";

export type TokenId = string;

export interface Offer {
  id: string;
  agent: string;
  give: TokenId;
  giveMax: bigint;
  want: TokenId;
  rateNum: bigint;
  rateDen: bigint;
  expiresAtMs: number;
}

export interface Leg {
  agent: string;
  offerId: string;
  give: TokenId;
  giveAmt: bigint;
  get: TokenId;
  getAmt: bigint;
}

export interface Ring {
  ringId: string;
  k: number;
  legs: Leg[];
  matcherLeg: { token: TokenId; amt: bigint };
  /** S = prod(1 - fee) / prod(rho). */
  surplusFactor: number;
  /** USD value of the whole surplus, if prices were given. */
  surplusUsd: number | null;
}

export interface FindOpts {
  maxLen?: number; // default 5
  phi?: number; // matcher share of log surplus, default 0.2
  feePips: number;
  priceUsd?: Record<TokenId, number>; // per whole token
  decimals?: Record<TokenId, number>;
  nowMs?: number;
  /** Skip rings where any leg gives less than this many smallest units (default 1000). */
  minGiveUnits?: bigint;
  /** Skip rings whose first leg is worth less than this (needs prices). */
  minLegUsd?: number;
  /** Mixed into ringId so the same legs proposed twice get different ids. */
  salt?: string;
  maxRings?: number;
}

const PIPS = 1_000_000n;
const G_SCALE = 10n ** 18n;

export const feeOf = (amount: bigint, feePips: number): bigint =>
  amount <= 0n ? 0n : (amount * BigInt(feePips) + PIPS - 1n) / PIPS;

/** Smallest x with x - fee(x) >= y. */
export function grossFor(y: bigint, feePips: number): bigint {
  if (y <= 0n) return 0n;
  const p = BigInt(feePips);
  let x = (y * PIPS + (PIPS - p) - 1n) / (PIPS - p);
  while (x - feeOf(x, feePips) < y) x++;
  while (x > 1n && x - 1n - feeOf(x - 1n, feePips) >= y) x--;
  return x;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const rho = (o: Offer) => Number(o.rateNum) / Number(o.rateDen);

/** Enumerate simple token cycles of length 2..L (rotation-deduplicated: start = min token index). */
export function tokenCycles(tokens: TokenId[], edges: Map<TokenId, Set<TokenId>>, L: number): TokenId[][] {
  const idx = new Map(tokens.map((t, i) => [t, i]));
  const out: TokenId[][] = [];
  for (const start of tokens) {
    const s = idx.get(start)!;
    const path: TokenId[] = [start];
    const seen = new Set([start]);
    const dfs = (cur: TokenId) => {
      for (const nxt of edges.get(cur) ?? []) {
        if (nxt === start && path.length >= 2) out.push([...path]);
        else if (!seen.has(nxt) && idx.get(nxt)! > s && path.length < L) {
          seen.add(nxt);
          path.push(nxt);
          dfs(nxt);
          path.pop();
          seen.delete(nxt);
        }
      }
    };
    dfs(start);
  }
  return out;
}

/** Choose one offer per edge of a token cycle: best rate, distinct agents. */
function pickOffers(cycle: TokenId[], byEdge: Map<string, Offer[]>): Offer[] | null {
  const used = new Set<string>();
  const chosen: Offer[] = [];
  for (let i = 0; i < cycle.length; i++) {
    const give = cycle[i]!, want = cycle[(i + 1) % cycle.length]!;
    const cands = byEdge.get(`${give}\u0000${want}`) ?? [];
    const o = cands.find((c) => !used.has(c.agent));
    if (!o) return null;
    used.add(o.agent);
    chosen.push(o);
  }
  return chosen;
}

/** Size a chosen cycle of offers into integer legs. Returns null if it can't clear. */
export function sizeRing(offers: Offer[], opts: FindOpts): Omit<Ring, "ringId"> | null {
  const k = offers.length;
  const phi = opts.phi ?? 0.2;
  const feeFrac = opts.feePips / 1e6;
  const logS = offers.reduce((s, o) => s + Math.log(1 - feeFrac) - Math.log(rho(o)), 0);
  if (!(logS > 0)) return null;
  const S = Math.exp(logS);
  const g = Math.exp((logS * (1 - phi)) / k);
  const G = BigInt(Math.floor(g * 1e18));

  // Upper bound for x_1 from capacities (float), then shrink until the integer pass fits.
  let factor = 1; // cumulative x_i / x_1
  let x1max = Number(offers[0]!.giveMax);
  for (let i = 1; i < k; i++) {
    factor *= (rho(offers[i - 1]!) * g) / (1 - feeFrac);
    x1max = Math.min(x1max, Number(offers[i]!.giveMax) / factor);
  }
  let x1 = BigInt(Math.floor(x1max * 0.999999));
  if (x1 > offers[0]!.giveMax) x1 = offers[0]!.giveMax;

  for (let attempt = 0; attempt < 40 && x1 > 0n; attempt++) {
    const sized = integerPass(offers, x1, G, opts.feePips);
    if (sized === "capacity") {
      x1 = (x1 * 99n) / 100n;
      continue;
    }
    if (sized === null) return null;
    const minUnits = minUnitsOf(opts);
    if (sized.legs.some((l) => l.giveAmt < minUnits)) return null;
    let surplusUsd: number | null = null;
    const t0 = offers[0]!.give;
    if (opts.priceUsd?.[t0] !== undefined && opts.decimals?.[t0] !== undefined) {
      const v = (Number(x1) / 10 ** opts.decimals[t0]!) * opts.priceUsd[t0]!;
      if (opts.minLegUsd !== undefined && v < opts.minLegUsd) return null;
      surplusUsd = v * (S - 1);
    }
    return { k, legs: sized.legs, matcherLeg: sized.matcherLeg, surplusFactor: S, surplusUsd };
  }
  return null;
}

function integerPass(
  offers: Offer[],
  x1: bigint,
  G: bigint,
  feePips: number,
): { legs: Leg[]; matcherLeg: { token: TokenId; amt: bigint } } | "capacity" | null {
  const k = offers.length;
  const x: bigint[] = [x1];
  const y: bigint[] = [];
  for (let i = 0; i < k; i++) {
    const o = offers[i]!;
    const req = ceilDiv(x[i]! * o.rateNum, o.rateDen); // agent i's minimum get
    const target = (x[i]! * o.rateNum * G) / (o.rateDen * G_SCALE);
    let yi = target > req ? target : req;
    if (i < k - 1) {
      const xn = grossFor(yi, feePips);
      if (xn > offers[i + 1]!.giveMax) return "capacity";
      x.push(xn);
      yi = xn - feeOf(xn, feePips); // exact net of the next give; >= target
      y.push(yi);
    } else {
      const avail = x1 - feeOf(x1, feePips);
      if (yi > avail) yi = req; // give the closing agent only its limit if the improved rate doesn't fit
      if (yi > avail) return null;
      y.push(yi);
    }
  }
  const legs: Leg[] = offers.map((o, i) => ({
    agent: o.agent,
    offerId: o.id,
    give: o.give,
    giveAmt: x[i]!,
    get: o.want,
    getAmt: y[i]!,
  }));
  const m = x1 - feeOf(x1, feePips) - y[k - 1]!;
  if (m < 0n) return null;
  return { legs, matcherLeg: { token: offers[0]!.give, amt: m } };
}

export function ringIdOf(legs: Leg[], matcherLeg: { token: TokenId; amt: bigint }, salt = ""): string {
  const canon = [...legs]
    .sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0))
    .map((l) => [l.agent, l.offerId, l.give, l.giveAmt.toString(), l.get, l.getAmt.toString()]);
  return createHash("sha256")
    .update(JSON.stringify({ legs: canon, m: [matcherLeg.token, matcherLeg.amt.toString()], salt }))
    .digest("hex");
}

/** Rotate a cycle so the closing token (matcher's leg) is the one with the highest value per smallest unit. */
function rotateForClosing(offers: Offer[], opts: FindOpts): Offer[] {
  if (!opts.priceUsd || !opts.decimals) return offers;
  let best = 0, bestV = -1;
  offers.forEach((o, i) => {
    const p = opts.priceUsd![o.give], d = opts.decimals![o.give];
    const v = p !== undefined && d !== undefined ? p / 10 ** d : -1;
    if (v > bestV) (bestV = v), (best = i);
  });
  return [...offers.slice(best), ...offers.slice(0, best)];
}

/** Find non-overlapping rings greedily by surplus (TECH_DOC §5.3). Pure; does not mutate input. */
export function findRings(input: Offer[], opts: FindOpts): Ring[] {
  const L = Math.min(Math.max(opts.maxLen ?? 5, 2), 5);
  const now = opts.nowMs ?? Date.now();
  let offers = input
    .filter((o) => o.expiresAtMs > now && o.giveMax > 0n && o.rateNum > 0n && o.rateDen > 0n && o.give !== o.want)
    .filter((o) => !isDust(o, o.giveMax, opts))
    .map((o) => ({ ...o }));
  const original = new Map(offers.map((o) => [o.id, o.giveMax]));
  const rings: Ring[] = [];
  const maxRings = opts.maxRings ?? 1000;

  while (rings.length < maxRings) {
    const tokens = [...new Set(offers.flatMap((o) => [o.give, o.want]))].sort();
    const edges = new Map<TokenId, Set<TokenId>>();
    const byEdge = new Map<string, Offer[]>();
    for (const o of offers) {
      if (!edges.has(o.give)) edges.set(o.give, new Set());
      edges.get(o.give)!.add(o.want);
      const key = `${o.give}\u0000${o.want}`;
      if (!byEdge.has(key)) byEdge.set(key, []);
      byEdge.get(key)!.push(o);
    }
    for (const list of byEdge.values()) list.sort((a, b) => rho(a) - rho(b) || (a.id < b.id ? -1 : 1));

    let best: { ring: Omit<Ring, "ringId">; score: number } | null = null;
    for (const cyc of tokenCycles(tokens, edges, L)) {
      const chosen = pickOffers(cyc, byEdge);
      if (!chosen) continue;
      const sized = sizeRing(rotateForClosing(chosen, opts), opts);
      if (!sized) continue;
      const score = sized.surplusUsd ?? Math.log(sized.surplusFactor);
      if (!best || score > best.score) best = { ring: sized, score };
    }
    if (!best) break;

    const ring: Ring = { ...best.ring, ringId: ringIdOf(best.ring.legs, best.ring.matcherLeg, `${opts.salt ?? ""}:${rings.length}`) };
    rings.push(ring);
    // consume capacities
    for (const l of ring.legs) {
      const o = offers.find((x) => x.id === l.offerId)!;
      o.giveMax -= l.giveAmt;
    }
    // Drop exhausted offers and dust remainders: a dust remainder would otherwise stay the
    // best-rate offer on its edge and block every other offer there.
    offers = offers.filter((o) => o.giveMax * 100n >= original.get(o.id)! && !isDust(o, o.giveMax, opts));
  }
  return rings;
}

/** Default floor: 1000 smallest units without prices; 1 unit when prices give a USD floor instead. */
const minUnitsOf = (opts: FindOpts) => opts.minGiveUnits ?? (opts.priceUsd ? 1n : 1000n);

/** Below minGiveUnits, or worth less than minLegUsd (default $0.01) when prices are known. */
function isDust(o: Offer, amt: bigint, opts: FindOpts): boolean {
  if (amt < (minUnitsOf(opts))) return true;
  const p = opts.priceUsd?.[o.give], d = opts.decimals?.[o.give];
  if (p === undefined || d === undefined) return false;
  return (Number(amt) / 10 ** d) * p < (opts.minLegUsd ?? 0.01);
}

export interface SignedDiff {
  account: string;
  diff: Record<TokenId, string>;
}

/** The exact token_diff each agent signs, plus the matcher's positive-only diff (omitted when zero). */
export function diffsFor(ring: Ring, matcher: string): SignedDiff[] {
  const out: SignedDiff[] = ring.legs.map((l) => ({
    account: l.agent,
    diff: { [l.give]: (-l.giveAmt).toString(), [l.get]: l.getAmt.toString() },
  }));
  if (ring.matcherLeg.amt > 0n) out.push({ account: matcher, diff: { [ring.matcherLeg.token]: ring.matcherLeg.amt.toString() } });
  return out;
}

/** Check the Verifier invariant for a set of diffs: per token, sum(positive) == sum(|neg| - fee). */
export function netsToZero(diffs: SignedDiff[], feePips: number): { ok: boolean; residual: Record<TokenId, bigint> } {
  const r: Record<TokenId, bigint> = {};
  for (const d of diffs)
    for (const [t, s] of Object.entries(d.diff)) {
      const v = BigInt(s);
      r[t] = (r[t] ?? 0n) + (v < 0n ? v + feeOf(-v, feePips) : v);
    }
  return { ok: Object.values(r).every((v) => v === 0n), residual: r };
}
