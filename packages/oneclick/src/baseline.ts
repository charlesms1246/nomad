// Ring baseline: what would 1Click have given for the same leg at the same moment?
// savings_bps = (ring getAmt − quote amountOut) / quote amountOut × 1e4 (TECH_DOC §10).
import { dryQuote, type ClientOptions, type DryQuote } from './client.js';
import { rescale, resolveToken, tokenMap, type TokenMapEntry } from './tokens.js';

export interface RingLeg {
  /** Nomad token id (testnet id), symbol, or mainnet asset id. */
  give: string;
  giveAmt: string | bigint;
  get: string;
  getAmt: string | bigint;
}

export interface Baseline {
  originAsset: string;
  destinationAsset: string;
  /** giveAmt in mainnet (1Click) units. */
  amountIn: string;
  /** getAmt in mainnet units. */
  ringAmountOut: string;
  quoteAmountOut: string;
  minAmountOut: string;
  /** Total app fee on the quote in bps (20 when keyless). */
  appFeeBps: number;
  /** amountOut with the app fee added back: amountOut × 1e4 / (1e4 − appFeeBps). */
  quoteAmountOutNoFee: string;
  /** Savings vs. the quote as served (fee included). */
  savingsBps: number;
  /** Savings vs. the quote with the app fee removed (the stricter figure). */
  savingsBpsNoFee: number;
  timestamp: string;
  quote: DryQuote;
}

export interface BaselineOptions extends ClientOptions {
  tokens?: TokenMapEntry[];
}

/** (ring − quote) / quote × 1e4, to 2 decimals. */
export function savingsBps(ringOut: bigint, quoteOut: bigint): number {
  if (quoteOut <= 0n) throw new Error('quote amountOut must be > 0');
  // Work in 1e-4 bps to keep two decimals without floating error on big amounts.
  const scaled = ((ringOut - quoteOut) * 10_000n * 100n) / quoteOut;
  return Number(scaled) / 100;
}

export function removeAppFee(amountOut: bigint, feeBps: number): bigint {
  if (!feeBps) return amountOut;
  return (amountOut * 10_000n) / BigInt(10_000 - feeBps);
}

function asset(ref: string, map: TokenMapEntry[]): { id: string; entry?: TokenMapEntry } {
  const entry = resolveToken(ref, map);
  if (entry) return { id: entry.assetId, entry };
  if (/^(nep141|nep245|1cs_v1):/.test(ref) && !ref.endsWith('.testnet')) return { id: ref };
  throw new Error(`no 1Click asset for token "${ref}"; add it with configureTokens()`);
}

export async function baseline(leg: RingLeg, opts: BaselineOptions = {}): Promise<Baseline> {
  const map = opts.tokens ?? tokenMap();
  const give = asset(leg.give, map);
  const get = asset(leg.get, map);
  const amountIn = give.entry
    ? rescale(BigInt(leg.giveAmt), give.entry.testnetDecimals, give.entry.decimals)
    : BigInt(leg.giveAmt);
  const ringOut = get.entry ? rescale(BigInt(leg.getAmt), get.entry.testnetDecimals, get.entry.decimals) : BigInt(leg.getAmt);
  if (amountIn <= 0n) throw new Error('giveAmt must be > 0');
  const quote = await dryQuote({ originAsset: give.id, destinationAsset: get.id, amount: amountIn }, opts);
  const out = BigInt(quote.amountOut);
  const appFeeBps = quote.appFees.reduce((s, f) => s + (Number(f.fee) || 0), 0);
  const noFee = removeAppFee(out, appFeeBps);
  return {
    originAsset: give.id,
    destinationAsset: get.id,
    amountIn: amountIn.toString(),
    ringAmountOut: ringOut.toString(),
    quoteAmountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    appFeeBps,
    quoteAmountOutNoFee: noFee.toString(),
    savingsBps: savingsBps(ringOut, out),
    savingsBpsNoFee: savingsBps(ringOut, noFee),
    timestamp: quote.timestamp,
    quote,
  };
}
