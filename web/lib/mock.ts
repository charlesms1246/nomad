// UI fixture used when no matcher API is configured or reachable.
// Everything here is invented for layout and rehearsal. meta.source = "mock"
// and the UI labels it MOCK DATA; tx hashes are fake and never linked.

import type { AgentState, NomadState, Offer, Ring, RingStatus, TokenMeta } from "./types";

const P = "nomadswarm.testnet";
const tok = (s: string) => `nep141:${s}.${P}`;

export const MOCK_TOKENS: TokenMeta[] = [
  { id: tok("wnear"), symbol: "wNEAR", decimals: 24, priceUsd: 3.54 },
  { id: tok("usdc"), symbol: "USDC", decimals: 6, priceUsd: 1 },
  { id: tok("usdt"), symbol: "USDT", decimals: 6, priceUsd: 1 },
  { id: tok("btc"), symbol: "BTC", decimals: 8, priceUsd: 68866 },
  { id: tok("zec"), symbol: "ZEC", decimals: 8, priceUsd: 955 },
];
const T = Object.fromEntries(MOCK_TOKENS.map((t) => [t.symbol, t])) as Record<string, TokenMeta>;

/** Human amount -> smallest-unit decimal string. */
function u(x: number, sym: string): string {
  const dec = BigInt(T[sym].decimals);
  return ((BigInt(Math.round(x * 1e9)) * 10n ** dec) / 10n ** 9n).toString();
}

/** Human rate (want per give) -> rateNum / rateDen in smallest units. */
function rate(rho: number, give: string, want: string) {
  return {
    rateNum: (BigInt(Math.round(rho * 1e9)) * 10n ** BigInt(T[want].decimals)).toString(),
    rateDen: (10n ** 9n * 10n ** BigInt(T[give].decimals)).toString(),
  };
}

const usd = (sym: string) => T[sym].priceUsd!;

// [agent, give, want, giveMax (human), limit margin below mid]
// Directions are chosen so that no two agents want each other's token:
// pairwise barter fails everywhere, and only loops can clear.
const BOOK: [string, string, string, number, number][] = [
  ["a01", "USDT", "BTC", 1.8, 0.012],
  ["a02", "BTC", "wNEAR", 0.000025, 0.011],
  ["a03", "ZEC", "USDC", 0.002, 0.008],
  ["a04", "wNEAR", "USDT", 0.5, 0.014],
  ["a05", "ZEC", "USDC", 0.0015, 0.013],
  ["a06", "BTC", "ZEC", 0.00002, 0.012],
  ["a07", "USDC", "wNEAR", 1.9, 0.009],
  ["a08", "ZEC", "USDT", 0.0018, 0.015],
  ["a09", "USDC", "BTC", 1.5, 0.01],
  ["a10", "USDT", "USDC", 2, 0.006],
  ["a11", "wNEAR", "ZEC", 0.54, 0.008],
  ["a12", "wNEAR", "USDT", 0.45, 0.012],
];

const STRATS = ["spender", "rebalancer", "collector", "random"];

function agentsAt(now: number, settled: boolean): AgentState[] {
  return BOOK.map(([name, give, want, max, margin], i) => {
    const id = `${name}.${P}`;
    const mid = usd(give) / usd(want);
    const offer: Offer = {
      id: String(100 + i),
      agent: id,
      give: T[give].id,
      giveMax: u(max, give),
      want: T[want].id,
      ...rate(mid * (1 - margin), give, want),
      createdAtMs: now - 40_000 - i * 1700,
      expiresAtMs: now + 3_000_000,
    };
    const holdings: Record<string, string> = { [T[give].id]: u(max * 1.25, give) };
    // The featured ring's agents show their post-settlement balances once it settles.
    const fx = FEATURED_DELTAS[name];
    if (fx) {
      holdings[T[fx.get].id] = settled ? u(fx.getAmt, fx.get) : "0";
      if (settled) holdings[T[give].id] = u(max * 1.25 - fx.giveAmt, give);
    }
    return {
      id,
      holdings,
      offers: settled && fx ? [] : [offer],
      strategy: STRATS[i % STRATS.length],
      unmatchedRounds: (i * 3) % 7,
    };
  });
}

const FEATURED_DELTAS: Record<string, { giveAmt: number; get: string; getAmt: number }> = {
  a03: { giveAmt: 0.002, get: "USDC", getAmt: 1.904 },
  a07: { giveAmt: 1.904, get: "wNEAR", getAmt: 0.5366 },
  a11: { giveAmt: 0.5366, get: "ZEC", getAmt: 0.00199 },
};

const hex = (seed: number) => {
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < 64; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out += (s >>> 28).toString(16);
  }
  return out;
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeTx = (seed: number) => {
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < 44; i++) {
    s = (s * 22695477 + 1) >>> 0;
    out += B58[(s >>> 16) % 58];
  }
  return out;
};

type LegSpec = [agent: string, give: string, giveAmt: number, get: string, getAmt: number];

function ring(
  seed: number,
  legs: LegSpec[],
  matcherAmt: number,
  o: Partial<Ring> & { status: RingStatus; proposedAtMs: number },
): Ring {
  const closing = legs[0][1];
  return {
    ringId: hex(seed),
    k: legs.length,
    legs: legs.map(([a, g, ga, w, wa]) => ({
      agent: `${a}.${P}`,
      give: T[g].id,
      giveAmt: u(ga, g),
      get: T[w].id,
      getAmt: u(wa, w),
    })),
    matcher: `intents-matcher.${P}`,
    matcherLeg: { token: T[closing].id, amt: u(matcherAmt, closing) },
    signedBy: legs.map(([a]) => `${a}.${P}`),
    surplusBps: 0,
    matcherShareBps: 0,
    savingsBps: null,
    savingsUsd: null,
    baselineQuotedAtMs: o.proposedAtMs,
    deadline: new Date(o.proposedAtMs + 120_000).toISOString(),
    settledAtMs: null,
    txHash: null,
    blockHeight: null,
    blocksToExec: null,
    gasBurntTgas: null,
    error: null,
    ...o,
  };
}

/** Lifecycle of the featured ring, looping every CYCLE_MS so a polling UI sees it move. */
export const CYCLE_MS = 30_000;
function featuredPhase(t: number): { status: RingStatus; signed: number } {
  if (t < 4000) return { status: "proposed", signed: 0 };
  if (t < 7000) return { status: "proposed", signed: 1 };
  if (t < 10000) return { status: "proposed", signed: 2 };
  if (t < 12000) return { status: "signed", signed: 3 };
  if (t < 13500) return { status: "simulated", signed: 3 };
  if (t < 14500) return { status: "submitted", signed: 3 };
  return { status: "settled", signed: 3 };
}

export function buildMockState(now: number = Date.now()): NomadState {
  const t = now % CYCLE_MS;
  const cycleStart = now - t;
  const ph = featuredPhase(t);
  const settled = ph.status === "settled";
  const order = ["a03", "a07", "a11"];

  const featured = ring(
    Math.floor(now / CYCLE_MS),
    [
      ["a03", "ZEC", 0.002, "USDC", 1.904],
      ["a07", "USDC", 1.904, "wNEAR", 0.5366],
      ["a11", "wNEAR", 0.5366, "ZEC", 0.00199],
    ],
    0.00001,
    {
      status: ph.status,
      proposedAtMs: cycleStart + 500,
      signedBy: order.slice(0, ph.signed).map((a) => `${a}.${P}`),
      surplusBps: 251,
      matcherShareBps: 50,
      savingsBps: settled ? 47.2 : null,
      savingsUsd: settled ? 0.0269 : null,
      settledAtMs: settled ? cycleStart + 14_500 : null,
      txHash: settled ? fakeTx(Math.floor(now / CYCLE_MS)) : null,
      blockHeight: settled ? 214_880_112 : null,
      blocksToExec: settled ? 0 : null,
      gasBurntTgas: settled ? 14.1 : null,
    },
  );

  const past: Ring[] = [
    ring(11, [["a02", "BTC", 0.00002, "wNEAR", 0.3871], ["a04", "wNEAR", 0.3871, "USDT", 1.3602], ["a01", "USDT", 1.3602, "BTC", 0.0000199]], 0.0000001, {
      status: "settled", proposedAtMs: now - 95_000, settledAtMs: now - 88_000, surplusBps: 182, matcherShareBps: 36, savingsBps: 44.8, savingsUsd: 0.0186, blocksToExec: 0, gasBurntTgas: 13.6, txHash: fakeTx(11), blockHeight: 214_879_960,
    }),
    ring(12, [["a10", "USDT", 1.2, "USDC", 1.1994], ["a09", "USDC", 1.1994, "BTC", 0.00001735], ["a06", "BTC", 0.00001735, "ZEC", 0.001248], ["a08", "ZEC", 0.001248, "USDT", 1.1932]], 0.0068, {
      status: "settled", proposedAtMs: now - 160_000, settledAtMs: now - 151_000, surplusBps: 310, matcherShareBps: 62, savingsBps: 51.3, savingsUsd: 0.0246, blocksToExec: 0, gasBurntTgas: 17.9, txHash: fakeTx(12), blockHeight: 214_879_830,
    }),
    ring(13, [["a05", "ZEC", 0.0012, "USDC", 1.141], ["a07", "USDC", 1.141, "wNEAR", 0.3215], ["a11", "wNEAR", 0.3215, "ZEC", 0.001193]], 0.000007, {
      status: "failed", proposedAtMs: now - 210_000, surplusBps: 204, matcherShareBps: 41, error: "simulate_intents: insufficient balance or overflow (a11 spent first; nothing moved)",
    }),
    ring(14, [["a12", "wNEAR", 0.4, "USDT", 1.402], ["a10", "USDT", 1.402, "wNEAR", 0.3998]], 0.0002, {
      status: "settled", proposedAtMs: now - 260_000, settledAtMs: now - 254_000, surplusBps: 58, matcherShareBps: 12, savingsBps: 38.1, savingsUsd: 0.0107, blocksToExec: 1, gasBurntTgas: 8.2, txHash: fakeTx(14), blockHeight: 214_879_640, matcher: `matcher.${P}`,
    }),
    ring(15, [["a01", "USDT", 1.5, "BTC", 0.0000216], ["a02", "BTC", 0.0000216, "wNEAR", 0.4187], ["a12", "wNEAR", 0.4187, "USDT", 1.4744], ["a10", "USDT", 1.4744, "USDC", 1.4738], ["a09", "USDC", 1.4738, "USDT", 1.4728]], 0.0272, {
      status: "settled", proposedAtMs: now - 330_000, settledAtMs: now - 322_000, surplusBps: 402, matcherShareBps: 80, savingsBps: 55.6, savingsUsd: 0.041, blocksToExec: 0, gasBurntTgas: 22.4, txHash: fakeTx(15), blockHeight: 214_879_480,
    }),
  ];
  // Rings 14 and 15 are illustrative of k=2 and k=5; their agents/directions
  // do not need to match the current book.

  return {
    meta: {
      network: "testnet",
      verifier: `intents.${P}`,
      verifierShard: 7,
      board: `board.${P}`,
      explorerTxUrl: "https://testnet.nearblocks.io/txns/",
      generatedAtMs: now,
      source: "mock",
      tokens: MOCK_TOKENS,
      baseline: { pair: "wNEAR→USDC", bps: 49, quotedAtMs: Date.UTC(2026, 10, 13, 12, 0) },
    },
    agents: agentsAt(now, settled),
    rings: [featured, ...past],
    swarm: {
      source: "sim",
      seed: 1,
      points: [4, 8, 12, 16, 20, 30, 40].map((n, i) => ({
        agents: n,
        tokens: 5,
        clearingRate: [0.08, 0.21, 0.36, 0.47, 0.58, 0.69, 0.76][i],
        fallbackRate: [0.92, 0.79, 0.64, 0.53, 0.42, 0.31, 0.24][i],
        ringsSettled: [1, 4, 9, 15, 22, 39, 61][i],
        meanSavingsBps: [41, 43, 44, 45, 46, 46, 47][i],
      })),
      ringLengthHist: { "2": 9, "3": 17, "4": 8, "5": 3 },
    },
    race: {
      rounds: 40,
      matchers: [
        { account: `intents-matcher.${P}`, shard: 7, colocated: true, wins: 29, blocksToExecHist: { "0": 27, "1": 2 } },
        { account: `matcher.${P}`, shard: 4, colocated: false, wins: 11, blocksToExecHist: { "0": 0, "1": 10, "2": 1 } },
      ],
    },
  };
}
