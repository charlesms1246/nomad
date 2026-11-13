#!/usr/bin/env node
// make sim [AGENTS=20 TOKENS=5 SEED=1] [SWEEP=1] [SERVE=1 PORT=8787]
// No chain, no keys. Prints one summary line, writes out/sim.json and SVG plots.
import fs from "node:fs";
import path from "node:path";
import { runSim, SIM_TOKENS, DEFAULT_BASELINE_BPS } from "./sim.js";
import { buildState } from "./state.js";
import { startServer } from "./server.js";
import { svgLines, svgBars } from "./plot.js";
import type { Ring, SwarmPoint, SwarmStats } from "./types.js";
import { AgentRuntime } from "@nomad/agent";

const env = (k: string, d: string) => process.env[k] ?? d;
const AGENTS = +env("AGENTS", "20");
const TOKENS = +env("TOKENS", "5");
const SEED = +env("SEED", "1");
const ROUNDS = +env("ROUNDS", "30");
const OUT = path.resolve(env("OUT_DIR", path.join(process.cwd(), "out")));
const BASELINE = +env("BASELINE_BPS", String(DEFAULT_BASELINE_BPS));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const one = await runSim({ agents: AGENTS, tokens: TOKENS, seed: SEED, rounds: ROUNDS, baselineBps: BASELINE });
  const p = one.point;
  const hist = Object.entries(one.ringLengthHist).map(([k, n]) => `k=${k}:${n}`).join(" ");
  console.log(
    `sim agents=${AGENTS} tokens=${p.tokens} seed=${SEED} rounds=${ROUNDS}: settled ${p.ringsSettled} rings (${hist}), ` +
      `cleared ${(p.clearingRate * 100).toFixed(0)}% of offers by rings (${one.offersCleared}/${one.offersCleared + one.offersFallback}), ` +
      `${(p.fallbackRate * 100).toFixed(0)}% fell back to 1Click; ` +
      `agents' mean rate vs mid ${one.meanImprovementBps?.toFixed(1)} bps vs 1Click baseline -${BASELINE} bps ` +
      `=> saved ${p.meanSavingsBps} bps; failed rings ${one.rings.filter((r) => r.status === "failed").length}`,
  );

  const points: SwarmPoint[] = [];
  const lengthHist: Record<string, number> = {};
  if (env("SWEEP", "1") === "1") {
    for (const tokens of [3, 5, 8]) {
      for (const agents of [10, 20, 50, 100, 200]) {
        // average over seeds for a smoother curve
        const seeds = [SEED, SEED + 1, SEED + 2];
        const rs = await Promise.all(seeds.map((s) => runSim({ agents, tokens, seed: s, rounds: ROUNDS, baselineBps: BASELINE })));
        const avg = (f: (r: (typeof rs)[number]) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
        points.push({
          agents,
          tokens,
          clearingRate: avg((r) => r.point.clearingRate),
          fallbackRate: avg((r) => r.point.fallbackRate),
          ringsSettled: Math.round(avg((r) => r.point.ringsSettled)),
          meanSavingsBps: Math.round(avg((r) => r.point.meanSavingsBps ?? 0) * 10) / 10,
        });
        if (tokens === TOKENS) for (const r of rs) for (const [k, n] of Object.entries(r.ringLengthHist)) lengthHist[k] = (lengthHist[k] ?? 0) + n;
        console.log(`  sweep tokens=${tokens} agents=${agents}: clearing ${(points.at(-1)!.clearingRate * 100).toFixed(1)}%, rings ${points.at(-1)!.ringsSettled}`);
      }
    }
    fs.writeFileSync(
      path.join(OUT, "clearing-rate.svg"),
      svgLines({
        title: "Share of offers cleared by rings vs swarm size",
        xLabel: "agents",
        yLabel: "cleared by rings (%)",
        series: [3, 5, 8].map((t) => ({
          name: `${t} tokens`,
          points: points.filter((p) => p.tokens === t).map((p) => [p.agents, p.clearingRate * 100] as [number, number]),
        })),
      }),
    );
    fs.writeFileSync(
      path.join(OUT, "ring-lengths.svg"),
      svgBars({ title: `Ring lengths settled (${TOKENS} tokens, all sweep sizes)`, xLabel: "agents in ring (k)", bars: Object.entries(lengthHist).sort() }),
    );
  }

  const swarm: SwarmStats = { source: "sim", seed: SEED, points, ringLengthHist: Object.keys(lengthHist).length ? lengthHist : one.ringLengthHist };
  const summary = {
    generatedAt: new Date().toISOString(),
    params: { agents: AGENTS, tokens: TOKENS, seed: SEED, rounds: ROUNDS, baselineBps: BASELINE },
    run: { ...one.point, offersPosted: one.offersPosted, offersCleared: one.offersCleared, offersFallback: one.offersFallback, ringLengthHist: one.ringLengthHist },
    swarm,
  };
  fs.writeFileSync(path.join(OUT, "sim.json"), JSON.stringify(summary, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), OUT)}/sim.json${points.length ? ", clearing-rate.svg, ring-lengths.svg" : ""}`);

  if (env("SERVE", "0") === "1") await serve(swarm);
}

/** Continuous sim behind /api/state, so the UI runs with no chain (labelled source: "sim"). */
async function serve(swarm: SwarmStats) {
  const rings: Ring[] = [];
  let agents: AgentRuntime[] = [];
  let seed = SEED;
  const tokens = SIM_TOKENS.slice(0, TOKENS);
  startServer({
    port: +env("PORT", "8787"),
    log: console.log,
    state: () =>
      buildState({
        meta: {
          network: "testnet",
          verifier: "intents.nomadswarm.testnet",
          verifierShard: null,
          board: "board.nomadswarm.testnet",
          explorerTxUrl: "https://testnet.nearblocks.io/txns/",
          source: "mock",
          tokens,
          baseline: { pair: "wNEAR->USDC", bps: BASELINE, quotedAtMs: Date.parse("2026-11-13T20:47:08Z") },
        },
        agents: () => agents,
        rings: () => rings,
        swarm: () => swarm,
        race: () => null,
      }),
  });
  for (;;) {
    const r = await runSim({ agents: AGENTS, tokens: TOKENS, seed: seed++, rounds: ROUNDS, baselineBps: BASELINE, roundDelayMs: +env("ROUND_MS", "2000"), onAgents: (a) => (agents = a), onRing: (x) => {
      if (!rings.includes(x)) rings.unshift(x);
      if (rings.length > 200) rings.length = 200;
    } });
    void r;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
