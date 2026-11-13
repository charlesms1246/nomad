// Builds the NomadState served at GET /api/state (shape owned by web/lib/types.ts).
import type { AgentRuntime, TokenInfo } from "@nomad/agent";
import type { NomadState, Ring, SwarmStats, RaceStats, Meta } from "./types.js";

export interface StateSources {
  meta: Omit<Meta, "generatedAtMs" | "tokens"> & { tokens: TokenInfo[] };
  agents: () => Iterable<AgentRuntime>;
  rings: () => Ring[];
  swarm: () => SwarmStats | null;
  race: () => RaceStats | null;
}

export function buildState(s: StateSources, nowMs = Date.now()): NomadState {
  const rings = [...s.rings()].sort((a, b) => b.proposedAtMs - a.proposedAtMs).slice(0, 200);
  return {
    meta: {
      ...s.meta,
      generatedAtMs: nowMs,
      tokens: s.meta.tokens.map((t) => ({ id: t.id, symbol: t.symbol, decimals: t.decimals, priceUsd: t.priceUsd })),
    },
    agents: [...s.agents()].map((a) => ({
      id: a.id,
      holdings: Object.fromEntries(Object.entries(a.balances).map(([k, v]) => [k, v.toString()])),
      offers: a.offers
        .filter((o) => o.expiresAtMs > nowMs)
        .map((o) => ({
          id: o.id,
          agent: o.agent,
          give: o.give,
          giveMax: o.giveMax.toString(),
          want: o.want,
          rateNum: o.rateNum.toString(),
          rateDen: o.rateDen.toString(),
          expiresAtMs: o.expiresAtMs,
          createdAtMs: o.expiresAtMs - (a.cfg.ttlMs ?? 600_000),
        })),
      strategy: a.cfg.marginAdvisor ? "llm" : a.cfg.strategy,
      unmatchedRounds: a.unmatchedRounds,
    })),
    rings,
    swarm: s.swarm(),
    race: s.race(),
  };
}

export const jsonBig = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
