// Map from Nomad's testnet token ids to the mainnet 1Click asset ids used for pricing.
// The testnet ids are placeholders until the test tokens are deployed; override them with
// configureTokens() or the NOMAD_TESTNET_TOKENS env var (JSON: {"USDC":"nep141:usdc.x.testnet", ...}).

export type TokenSymbol = 'wNEAR' | 'USDC' | 'USDT' | 'BTC' | 'ZEC';

export interface TokenMapEntry {
  symbol: TokenSymbol;
  /** Nomad's testnet token id, e.g. "nep141:usdc.nomadswarm.testnet". */
  testnetId: string;
  /** Decimals of the testnet token (defaults to the mainnet decimals). */
  testnetDecimals: number;
  /** 1Click (mainnet) asset id. */
  assetId: string;
  /** Mainnet decimals. */
  decimals: number;
}

export const MAINNET_ASSETS: Record<TokenSymbol, { assetId: string; decimals: number }> = {
  wNEAR: { assetId: 'nep141:wrap.near', decimals: 24 },
  USDC: { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
  USDT: { assetId: 'nep141:usdt.tether-token.near', decimals: 6 },
  BTC: { assetId: 'nep141:btc.omft.near', decimals: 8 },
  ZEC: { assetId: 'nep141:zec.omft.near', decimals: 8 },
};

export const DEFAULT_TESTNET_IDS: Record<TokenSymbol, string> = {
  wNEAR: 'nep141:wnear.nomadswarm.testnet',
  USDC: 'nep141:usdc.nomadswarm.testnet',
  USDT: 'nep141:usdt.nomadswarm.testnet',
  BTC: 'nep141:btc.nomadswarm.testnet',
  ZEC: 'nep141:zec.nomadswarm.testnet',
};

export type TokenOverrides = Partial<Record<TokenSymbol, string | { testnetId?: string; testnetDecimals?: number }>>;

function envOverrides(): TokenOverrides {
  const raw = process.env.NOMAD_TESTNET_TOKENS;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('NOMAD_TESTNET_TOKENS must be JSON, e.g. {"USDC":"nep141:usdc.nomadswarm.testnet"}');
  }
}

export function buildTokenMap(overrides: TokenOverrides = {}): TokenMapEntry[] {
  const merged: TokenOverrides = { ...envOverrides(), ...overrides };
  return (Object.keys(MAINNET_ASSETS) as TokenSymbol[]).map((symbol) => {
    const o = merged[symbol];
    const ov = typeof o === 'string' ? { testnetId: o } : (o ?? {});
    const m = MAINNET_ASSETS[symbol];
    return {
      symbol,
      testnetId: ov.testnetId ?? DEFAULT_TESTNET_IDS[symbol],
      testnetDecimals: ov.testnetDecimals ?? m.decimals,
      assetId: m.assetId,
      decimals: m.decimals,
    };
  });
}

let current: TokenMapEntry[] | null = null;

/** Replace the active token map (e.g. once agent1 publishes the deployed test token ids). */
export function configureTokens(overrides: TokenOverrides = {}): TokenMapEntry[] {
  current = buildTokenMap(overrides);
  return current;
}

export function tokenMap(): TokenMapEntry[] {
  return (current ??= buildTokenMap());
}

/**
 * Resolve a token reference (testnet id, symbol, or a mainnet asset id) to its map entry.
 * Returns undefined for unknown ids.
 */
export function resolveToken(ref: string, map: TokenMapEntry[] = tokenMap()): TokenMapEntry | undefined {
  return map.find((t) => t.testnetId === ref || t.assetId === ref || t.symbol.toLowerCase() === ref.toLowerCase());
}

/** Rescale an amount between decimals (truncating when reducing precision). */
export function rescale(amount: bigint, from: number, to: number): bigint {
  if (to === from) return amount;
  return to > from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to);
}
