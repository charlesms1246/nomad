/**
 * Verifier fee rule (BUILD_PLAN C1, defuse `token_diff.rs`): for every negative delta d of a
 * NEP-141 token, fee = ceil(|d| * feePips / 1_000_000). Positive deltas pay nothing.
 */
export const PIPS_DENOM = 1_000_000n;

export function feeOf(amount: bigint, feePips: number | bigint): bigint {
  const a = amount < 0n ? -amount : amount;
  const f = BigInt(feePips);
  return (a * f + PIPS_DENOM - 1n) / PIPS_DENOM;
}

/** What the counterparty can receive when `amount` is given: amount − ceil(amount·fee/1e6). */
export function netOfFee(amount: bigint, feePips: number | bigint): bigint {
  return amount - feeOf(amount, feePips);
}

/**
 * Smallest gross amount g such that g − fee(g) ≥ net (the amount a giver must put in so the
 * receiver gets `net`).
 */
export function grossForNet(net: bigint, feePips: number | bigint): bigint {
  const f = BigInt(feePips);
  if (net <= 0n) return 0n;
  // g·(1e6 − f)/1e6 ≈ net; start from the ceil estimate and adjust.
  let g = (net * PIPS_DENOM + (PIPS_DENOM - f) - 1n) / (PIPS_DENOM - f);
  while (g > 0n && netOfFee(g - 1n, f) >= net) g--;
  while (netOfFee(g, f) < net) g++;
  return g;
}

/** Same arithmetic as defuse `TokenDiff::closure_deltas` for NEP-141 tokens. */
export function closureDeltas(deltas: Record<string, bigint>[], feePips: number | bigint): Record<string, bigint> {
  const f = BigInt(feePips);
  const supply: Record<string, bigint> = {};
  for (const d of deltas)
    for (const [t, v] of Object.entries(d)) {
      // supply delta of a negative delta: ceil(v * (1e6 - f) / 1e6) (toward +inf for negatives)
      const s = v < 0n ? ceilDiv(v * (PIPS_DENOM - f), PIPS_DENOM) : v;
      supply[t] = (supply[t] ?? 0n) + s;
    }
  const out: Record<string, bigint> = {};
  for (const [t, s] of Object.entries(supply)) {
    if (s === 0n) continue;
    const c = -s;
    // closure < 0: floor-euclid(c * 1e6 / (1e6 - f))
    out[t] = c < 0n ? floorDiv(c * PIPS_DENOM, PIPS_DENOM - f) : c;
  }
  return out;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n === b < 0n ? q + 1n : q;
}
