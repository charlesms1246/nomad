// `make sim`: a seeded swarm of scripted agents trading in rings, with no chain and no keys.
// The swarms track asks for a simulation mode with scripted strategies and no LLM calls.

import { AgentRuntime, rngFrom, type StrategyName, type TokenInfo, type MultiPayload, type Offer } from "@nomad/agent";
import { Matcher } from "./matcher.js";
import { InProcessLink } from "./inprocess.js";
import { LedgerChain } from "./ledger.js";
import type { Chain } from "./chain.js";
import type { Ring as UiRing, SwarmPoint } from "./types.js";

/** Token universe. Prices are the 1Click /v0/tokens snapshot of 2026-11-13 (docs/spec/supplementary/probes/data). */
export const SIM_TOKENS: TokenInfo[] = [
  { id: "nep141:wnear.nomadswarm.testnet", symbol: "wNEAR", decimals: 24, priceUsd: 3.54 },
  { id: "nep141:usdc.nomadswarm.testnet", symbol: "USDC", decimals: 6, priceUsd: 0.999533 },
  { id: "nep141:usdt.nomadswarm.testnet", symbol: "USDT", decimals: 6, priceUsd: 0.999187 },
  { id: "nep141:zec.nomadswarm.testnet", symbol: "ZEC", decimals: 8, priceUsd: 955.28 },
  { id: "nep141:btc.nomadswarm.testnet", symbol: "BTC", decimals: 8, priceUsd: 68866 },
  { id: "nep141:sol.nomadswarm.testnet", symbol: "SOL", decimals: 9, priceUsd: 80.06 },
  { id: "nep141:eth.nomadswarm.testnet", symbol: "ETH", decimals: 18, priceUsd: 1945.94 },
  { id: "nep141:usdc-eth.nomadswarm.testnet", symbol: "USDC.e", decimals: 6, priceUsd: 0.999533 },
];

/** Measured 1Click spread for a small trade, incl. the 20 bps keyless app fee (IDEA §1; re-measured by `oneclick`). */
export const DEFAULT_BASELINE_BPS = 49;

export interface SimOpts {
  agents: number;
  tokens: number;
  seed: number;
  rounds?: number; // matching rounds (2 s each in sim time)
  fallbackAfter?: number; // rounds unmatched before 1Click fallback (RULES §5)
  baselineBps?: number;
  maxLen?: number;
  chain?: Chain;
  onRing?: (r: UiRing) => void;
}

export interface SimResult {
  point: SwarmPoint;
  ringLengthHist: Record<string, number>;
  rings: UiRing[];
  offersPosted: number;
  offersCleared: number;
  offersFallback: number;
  meanImprovementBps: number | null; // agents' realised rate vs their limit
}

const STRATS: StrategyName[] = ["spender", "rebalancer", "collector", "random"];
const sym = (t: TokenInfo) => t.symbol;

/** Signature-free signer for sim (the LedgerChain doesn't check signatures; nonces are unique). */
export const simSigner =
  (account: string, rng: () => number) =>
  (a: { diff: Record<string, string>; deadline: Date; salt: string; verifierId: string; memo?: string }): MultiPayload => ({
    standard: "nep413",
    payload: {
      message: JSON.stringify({
        signer_id: account,
        verifying_contract: a.verifierId,
        deadline: a.deadline.toISOString(),
        intents: [{ intent: "token_diff", diff: a.diff, ...(a.memo ? { memo: a.memo } : {}) }],
      }),
      nonce: Buffer.from(Array.from({ length: 32 }, () => Math.floor(rng() * 256))).toString("base64"),
      recipient: a.verifierId,
    },
    public_key: "ed25519:sim",
    signature: "ed25519:sim",
  });

export async function runSim(o: SimOpts): Promise<SimResult> {
  const rng = rngFrom(o.seed);
  const tokens = SIM_TOKENS.slice(0, Math.max(2, Math.min(o.tokens, SIM_TOKENS.length)));
  const chain = o.chain ?? new LedgerChain();
  const ledger = chain instanceof LedgerChain ? chain : null;
  let now = 1_800_000_000_000;
  const clock = () => now;

  // Fund agents: each holds ~$1-2 of one or two tokens and wants something else.
  const agents = new Map<string, AgentRuntime>();
  for (let i = 1; i <= o.agents; i++) {
    const id = `a${String(i).padStart(2, "0")}.nomadswarm.testnet`;
    const strategy = STRATS[Math.floor(rng() * STRATS.length)]!;
    const nHold = rng() < 0.3 ? 2 : 1;
    const held = new Set<number>();
    while (held.size < nHold) held.add(Math.floor(rng() * tokens.length));
    for (const h of held) {
      const t = tokens[h]!;
      const usd = 1 + rng();
      const amt = BigInt(Math.floor((usd / nHold / t.priceUsd) * 10 ** Math.min(t.decimals, 15))) * 10n ** BigInt(Math.max(0, t.decimals - 15));
      ledger?.credit(id, t.id, amt);
    }
    let target = tokens[Math.floor(rng() * tokens.length)]!.id;
    if (held.size === 1 && tokens[[...held][0]!]!.id === target) target = tokens[([...held][0]! + 1) % tokens.length]!.id;
    agents.set(
      id,
      new AgentRuntime(
        { id, strategy, target, margin: rng() * 0.015, sizeFrac: 0.5 + rng() * 0.5, ttlMs: 60_000, verifierId: chain.verifierId },
        simSigner(id, rng),
        (ts) => chain.balances(id, ts),
        rngFrom(o.seed * 1000 + i),
      ),
    );
  }

  const rings: UiRing[] = [];
  const matcher = new Matcher(
    {
      account: "intents-matcher.nomadswarm.testnet",
      shard: null,
      maxLen: o.maxLen ?? 5,
      now: clock,
      priceUsd: Object.fromEntries(tokens.map((t) => [t.id, t.priceUsd])),
      decimals: Object.fromEntries(tokens.map((t) => [t.id, t.decimals])),
      onRing: o.onRing,
    },
    chain,
    simSigner("intents-matcher.nomadswarm.testnet", rng),
    new InProcessLink(agents, clock),
  );

  const fallbackAfter = o.fallbackAfter ?? 5;
  const age = new Map<string, number>(); // offer id -> rounds seen unmatched
  const filled = new Set<string>();
  const posted = new Set<string>();
  const fellBack = new Set<string>();
  const improvements: number[] = [];
  const priceOf = Object.fromEntries(tokens.map((t) => [t.id, t]));
  const R = o.rounds ?? 30;
  const baseline = o.baselineBps ?? DEFAULT_BASELINE_BPS;

  for (let round = 0; round < R; round++) {
    const book: Offer[] = [];
    for (const a of agents.values()) {
      // drop offers that hit the fallback threshold: those go to 1Click instead
      const keep: Offer[] = [];
      for (const of of a.offers) {
        if ((age.get(of.id) ?? 0) >= fallbackAfter && !filled.has(of.id)) {
          fellBack.add(of.id);
          // The agent takes the 1Click route at mid price minus the baseline spread (sim only).
          if (ledger) {
            const have = (await chain.balances(a.id, [of.give]))[of.give] ?? 0n;
            const amt = of.giveMax < have ? of.giveMax : have;
            if (amt > 0n) {
              const g = priceOf[of.give]!, w = priceOf[of.want]!;
              const usd = (Number(amt) / 10 ** g.decimals) * g.priceUsd * (1 - baseline / 1e4);
              const out = BigInt(Math.floor((usd / w.priceUsd) * 10 ** Math.min(w.decimals, 15))) * 10n ** BigInt(Math.max(0, w.decimals - 15));
              ledger.credit(a.id, of.give, -amt);
              ledger.credit(a.id, of.want, out);
              ledger.credit("1click.sim", of.give, amt);
            }
          }
        } else keep.push(of);
      }
      a.offers = keep;
      const offers = await a.refresh(tokens, now);
      for (const of of offers) {
        posted.add(of.id);
        book.push(of);
      }
    }
    const res = await matcher.round(book);
    for (const r of res) {
      rings.push(r);
      if (r.status !== "settled") continue;
      for (const l of r.legs) {
        if (l.offerId) filled.add(l.offerId);
        const g = priceOf[l.give]!, w = priceOf[l.get]!;
        const usdIn = (Number(l.giveAmt) / 10 ** g.decimals) * g.priceUsd;
        const usdOut = (Number(l.getAmt) / 10 ** w.decimals) * w.priceUsd;
        improvements.push((usdOut / usdIn - 1) * 1e4);
      }
    }
    for (const of of book) if (!filled.has(of.id)) age.set(of.id, (age.get(of.id) ?? 0) + 1);
    now += 2_000;
  }

  const settled = rings.filter((r) => r.status === "settled");
  const hist: Record<string, number> = {};
  for (const r of settled) hist[String(r.k)] = (hist[String(r.k)] ?? 0) + 1;
  const decided = filled.size + fellBack.size;
  // Agents' realised rate vs mid price (bps, usually small negative: their margin) vs the 1Click baseline (-baseline bps).
  const meanVsMid = improvements.length ? improvements.reduce((s, x) => s + x, 0) / improvements.length : null;
  for (const r of settled) r.savingsBps = meanVsMid === null ? null : Math.round((meanVsMid + baseline) * 10) / 10;

  return {
    point: {
      agents: o.agents,
      tokens: tokens.length,
      clearingRate: decided ? filled.size / decided : 0,
      fallbackRate: decided ? fellBack.size / decided : 0,
      ringsSettled: settled.length,
      meanSavingsBps: meanVsMid === null ? null : Math.round((meanVsMid + baseline) * 10) / 10,
    },
    ringLengthHist: hist,
    rings,
    offersPosted: posted.size,
    offersCleared: filled.size,
    offersFallback: fellBack.size,
    meanImprovementBps: meanVsMid,
  };
}

export const tokenSymbols = (n: number) => SIM_TOKENS.slice(0, n).map(sym);
