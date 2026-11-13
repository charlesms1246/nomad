// The 60-second demo (IDEA §10.1) as a deterministic timeline over a frozen
// state snapshot. It replays a real ring from the snapshot (live or mock); it
// never invents a tx hash. A ring that has no hash yet shows none.

import type { AgentState, NomadState, Ring } from "./types";

export type DemoPhase = "intro" | "pairs" | "ring" | "settle" | "savings" | "outro" | "done";

export const DEMO_MS = 60_000;

const PHASES: [DemoPhase, number, string][] = [
  ["intro", 0, "These AI agents got paid in different tokens. Each needs something it doesn't have."],
  ["pairs", 8_000, "No two of them can trade."],
  ["ring", 20_000, "But three of them can. Each agent signs only its own leg."],
  ["settle", 35_000, "One transaction on NEAR. All of them get paid, or no one does."],
  ["savings", 45_000, "No solver, no spread."],
  ["outro", 55_000, "Settled by NEAR Intents. Matcher co-located on the Verifier's shard."],
  ["done", DEMO_MS, ""],
];

export interface PairAttempt {
  from: string; // agent who wants
  to: string; // agent who has it, but wants something else
  wantSym: string;
}

export interface DemoFrame {
  phase: DemoPhase;
  caption: string;
  elapsed: number;
  ring: Ring | null; // focus ring with lifecycle overridden for the replay
  pair: PairAttempt | null;
  settledFlash: boolean;
}

/** The ring the demo replays: newest settled 3-ring, else newest settled, else newest. */
export function pickDemoRing(s: NomadState): Ring | null {
  return (
    s.rings.find((r) => r.status === "settled" && r.k === 3) ??
    s.rings.find((r) => r.status === "settled") ??
    s.rings[0] ??
    null
  );
}

/** One-way wants: A wants what B gives, but B does not want A's token. */
export function failedPairs(agents: AgentState[], symOf: (id: string) => string): PairAttempt[] {
  const out: PairAttempt[] = [];
  for (const a of agents) {
    for (const oa of a.offers) {
      for (const b of agents) {
        if (b.id === a.id) continue;
        for (const ob of b.offers) {
          if (ob.give === oa.want && ob.want !== oa.give) {
            out.push({ from: a.id, to: b.id, wantSym: symOf(oa.want) });
          }
        }
      }
    }
  }
  // Spread them around the circle: at most one attempt per "from" agent.
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.from) ? false : (seen.add(p.from), true)));
}

export function demoFrame(s: NomadState, base: Ring | null, pairs: PairAttempt[], elapsed: number): DemoFrame {
  let i = PHASES.length - 1;
  while (i > 0 && elapsed < PHASES[i][1]) i--;
  const [phase, , caption] = PHASES[i];

  let ring: Ring | null = null;
  let pair: PairAttempt | null = null;
  if (phase === "pairs" && pairs.length) {
    const slot = Math.floor((elapsed - 8_000) / 1_200);
    pair = pairs[slot % pairs.length];
  }
  if (base && (phase === "ring" || phase === "settle" || phase === "savings" || phase === "outro")) {
    ring = replay(base, elapsed - 20_000);
  }
  return {
    phase,
    caption,
    elapsed,
    ring,
    pair,
    settledFlash: phase === "settle" && elapsed < 41_000,
  };
}

function replay(r: Ring, t: number): Ring {
  const order = r.legs.map((l) => l.agent);
  const signStart = 2_000;
  const signEnd = 11_500;
  const step = (signEnd - signStart) / Math.max(1, order.length);
  const nSigned = t < signStart ? 0 : Math.min(order.length, 1 + Math.floor((t - signStart) / step));
  const settled = t >= 15_000 && r.status === "settled";
  const status: Ring["status"] =
    t >= 15_000 ? r.status : t >= 14_000 ? "submitted" : t >= 12_800 ? "simulated" : nSigned === order.length ? "signed" : "proposed";
  return {
    ...r,
    signedBy: order.slice(0, nSigned),
    status,
    txHash: settled ? r.txHash : null,
    blockHeight: settled ? r.blockHeight : null,
    blocksToExec: settled ? r.blocksToExec : null,
    savingsBps: settled ? r.savingsBps : null,
    savingsUsd: settled ? r.savingsUsd : null,
  };
}
