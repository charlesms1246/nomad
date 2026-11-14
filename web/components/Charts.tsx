"use client";

import { useState, type ReactNode } from "react";
import type { RaceStats, SwarmStats } from "@/lib/types";
import { shortAgent } from "@/lib/format";

const S1 = "#3987e5"; // categorical slot 1 (dark)
const S2 = "#d95926"; // categorical slot 2 (dark)
const S3 = "#2e9e6b"; // categorical slot 3 (dark)
const GRID = "#2c2c2a";
const AXIS = "#383835";
const MUTED = "#898781";

function Panel({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-[#1a1a19] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-[#c3c2b7]">{title}</h2>
        {note && <p className="text-[11px] text-[#898781]">{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-white/10 bg-[#0d0d0d] px-2.5 py-1.5 text-[11px] text-[#f0efec] shadow-lg"
      style={{ left: `${x}%`, top: `${y}%`, marginTop: -8 }}
    >
      {children}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-4 text-[11px] text-[#c3c2b7]">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Rounded top (4px), square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/* ---------------- Swarm ---------------- */

export function SwarmPanel({ swarm }: { swarm: SwarmStats | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoverK, setHoverK] = useState<string | null>(null);
  if (!swarm || swarm.points.length === 0) {
    return (
      <Panel title="Swarm">
        <p className="mt-3 text-xs text-[#898781]">No sim data yet. Run <code className="font-mono">make sim</code>.</p>
      </Panel>
    );
  }
  const pts = [...swarm.points].sort((a, b) => a.agents - b.agents);
  const W = 420, H = 190, L = 36, Rm = 12, T = 12, B = 28;
  const xMin = pts[0].agents, xMax = pts[pts.length - 1].agents;
  const xs = (v: number) => L + ((v - xMin) / Math.max(1, xMax - xMin)) * (W - L - Rm);
  const ys = (v: number) => T + (1 - v) * (H - T - B);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xs(p.agents)},${ys(p.clearingRate)}`).join(" ");
  const hp = hover != null ? pts[hover] : null;

  const ks = Object.keys(swarm.ringLengthHist).sort((a, b) => +a - +b);
  const maxK = Math.max(1, ...ks.map((k) => swarm.ringLengthHist[k]));
  const HW = 220, HH = 190, HL = 12, HB = 28, HT = 18;
  const bw = (HW - HL * 2) / ks.length;

  return (
    <Panel
      title="Swarm"
      note={`${swarm.source === "sim" ? "from simulation (make sim)" : "live"}${swarm.seed != null ? `, seed ${swarm.seed}` : ""}, ${pts[0].tokens} tokens`}
    >
      <div className="mt-3 grid grid-cols-1 gap-6 sm:grid-cols-[1fr_auto]">
        <figure>
          <figcaption className="mb-1 text-[11px] text-[#898781]">Share of offers cleared by rings, by agent count</figcaption>
          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
              {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                <g key={v}>
                  <line x1={L} x2={W - Rm} y1={ys(v)} y2={ys(v)} stroke={v === 0 ? AXIS : GRID} strokeWidth={1} />
                  <text x={L - 6} y={ys(v) + 3} textAnchor="end" fontSize={10} fill={MUTED}>{v * 100}%</text>
                </g>
              ))}
              {pts.map((p) => (
                <text key={p.agents} x={xs(p.agents)} y={H - 10} textAnchor="middle" fontSize={10} fill={MUTED}>{p.agents}</text>
              ))}
              <text x={W - Rm} y={H - 0} textAnchor="end" fontSize={10} fill={MUTED}>agents</text>
              {hp && <line x1={xs(hp.agents)} x2={xs(hp.agents)} y1={T} y2={H - B} stroke="#5c5b57" strokeWidth={1} />}
              <path d={line} fill="none" stroke={S1} strokeWidth={2} strokeLinejoin="round" />
              {pts.map((p, i) => (
                <circle key={p.agents} cx={xs(p.agents)} cy={ys(p.clearingRate)} r={hover === i ? 5 : 4} fill={S1} stroke="#1a1a19" strokeWidth={2} />
              ))}
              {/* hit targets: full-height columns */}
              {pts.map((p, i) => {
                const prev = i ? xs(pts[i - 1].agents) : L;
                const next = i < pts.length - 1 ? xs(pts[i + 1].agents) : W - Rm;
                const x0 = i ? (prev + xs(p.agents)) / 2 : L;
                const x1 = i < pts.length - 1 ? (xs(p.agents) + next) / 2 : W - Rm;
                return <rect key={p.agents} x={x0} y={T} width={x1 - x0} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />;
              })}
              {/* selective direct label: last point */}
              <text x={xs(pts[pts.length - 1].agents) - 6} y={ys(pts[pts.length - 1].clearingRate) - 10} textAnchor="end" fontSize={11} fill="#f0efec">
                {Math.round(pts[pts.length - 1].clearingRate * 100)}%
              </text>
            </svg>
            {hp && (
              <Tip x={(xs(hp.agents) / W) * 100} y={(ys(hp.clearingRate) / H) * 100}>
                <div className="font-semibold">{hp.agents} agents</div>
                <div>cleared by rings: {(hp.clearingRate * 100).toFixed(0)}%</div>
                <div>to 1Click fallback: {(hp.fallbackRate * 100).toFixed(0)}%</div>
                <div>rings settled: {hp.ringsSettled}</div>
                {hp.meanSavingsBps != null && <div>mean saving: {hp.meanSavingsBps.toFixed(1)} bps</div>}
              </Tip>
            )}
          </div>
        </figure>

        <figure className="sm:w-[220px]">
          <figcaption className="mb-1 text-[11px] text-[#898781]">Rings settled by length k</figcaption>
          <div className="relative">
            <svg viewBox={`0 0 ${HW} ${HH}`} className="w-full" onMouseLeave={() => setHoverK(null)}>
              <line x1={HL} x2={HW - HL} y1={HH - HB} y2={HH - HB} stroke={AXIS} />
              {ks.map((k, i) => {
                const v = swarm.ringLengthHist[k];
                const h = (v / maxK) * (HH - HB - HT);
                const x = HL + i * bw + 2 + bw * 0.12;
                const w = bw * 0.76 - 4;
                return (
                  <g key={k} onMouseEnter={() => setHoverK(k)}>
                    <rect x={HL + i * bw} y={HT} width={bw} height={HH - HB - HT} fill="transparent" />
                    <path d={barPath(x, HH - HB - h, w, h)} fill={S1} opacity={hoverK && hoverK !== k ? 0.5 : 1} />
                    <text x={x + w / 2} y={HH - HB - h - 5} textAnchor="middle" fontSize={11} fill="#f0efec">{v}</text>
                    <text x={x + w / 2} y={HH - 10} textAnchor="middle" fontSize={10} fill={MUTED}>k={k}</text>
                  </g>
                );
              })}
            </svg>
            {hoverK && (
              <Tip x={((HL + ks.indexOf(hoverK) * bw + bw / 2) / HW) * 100} y={20}>
                {swarm.ringLengthHist[hoverK]} rings of {hoverK} agents
              </Tip>
            )}
          </div>
        </figure>
      </div>
    </Panel>
  );
}

/* ---------------- Race ---------------- */

export function RacePanel({ race }: { race: RaceStats | null }) {
  const [hover, setHover] = useState<string | null>(null);
  if (!race || race.matchers.length === 0) {
    return (
      <Panel title="Race: who submits the batch">
        <p className="mt-3 text-xs text-[#898781]">No race data yet. Run <code className="font-mono">make race3</code>.</p>
      </Panel>
    );
  }
  // Order as served by the matcher (stable identity per slot).
  const ms = race.matchers;
  const color = (i: number) => [S1, S2, S3][i % 3];
  const signsAsVerifier = (m: (typeof ms)[number]) => / \(signs as /.test(m.account);
  const label = (m: (typeof ms)[number]) =>
    signsAsVerifier(m)
      ? `signs as the Verifier (delegated key) · shard ${m.shard}`
      : `${shortAgent(m.account.split(" ")[0])} · shard ${m.shard}${m.colocated ? " (Verifier's)" : ""}`;
  const totalWins = ms.reduce((s, m) => s + m.wins, 0) || 1;

  const buckets = [...new Set(ms.flatMap((m) => Object.keys(m.blocksToExecHist)))].sort((a, b) => +a - +b);
  const maxV = Math.max(1, ...ms.flatMap((m) => buckets.map((b) => m.blocksToExecHist[b] ?? 0)));
  const W = 420, H = 170, L = 12, B = 30, T = 18;
  const gw = (W - 2 * L) / buckets.length;
  const bw = Math.min(46, (gw * 0.7) / ms.length);

  return (
    <Panel title="Race: who submits the batch" note={`${race.rounds} contested rings · same rings, submitted at once`}>
      <div className="mt-3">
        <Legend items={ms.map((m, i) => ({ label: label(m), color: color(i) }))} />
      </div>

      <figure className="mt-4">
        <figcaption className="mb-1.5 text-[11px] text-[#898781]">Win share</figcaption>
        <div className="flex h-7 w-full gap-[2px] overflow-hidden rounded">
          {ms.map((m, i) => {
            const share = m.wins / totalWins;
            return (
              <div
                key={m.account}
                className="flex items-center px-2 text-[11px] font-medium text-white"
                style={{ width: `${share * 100}%`, background: color(i), minWidth: share > 0 ? 28 : 0 }}
                title={`${label(m)}: ${m.wins} wins`}
              >
                {share >= 0.12 && `${Math.round(share * 100)}%`}
              </div>
            );
          })}
        </div>
      </figure>

      <figure className="mt-5">
        <figcaption className="mb-1 text-[11px] text-[#898781]">Blocks from submission to execution</figcaption>
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
            <line x1={L} x2={W - L} y1={H - B} y2={H - B} stroke={AXIS} />
            {buckets.map((b, gi) => {
              const gx = L + gi * gw + (gw - ms.length * bw - (ms.length - 1) * 2) / 2;
              return (
                <g key={b}>
                  {ms.map((m, i) => {
                    const v = m.blocksToExecHist[b] ?? 0;
                    const h = (v / maxV) * (H - B - T);
                    const x = gx + i * (bw + 2);
                    const key = `${b}:${i}`;
                    return (
                      <g key={m.account} onMouseEnter={() => setHover(key)}>
                        <rect x={x - 2} y={T} width={bw + 4} height={H - B - T} fill="transparent" />
                        <path d={barPath(x, H - B - h, bw, h)} fill={color(i)} opacity={hover && hover !== key ? 0.5 : 1} />
                        {v > 0 && <text x={x + bw / 2} y={H - B - h - 5} textAnchor="middle" fontSize={11} fill="#f0efec">{v}</text>}
                      </g>
                    );
                  })}
                  <text x={L + gi * gw + gw / 2} y={H - 10} textAnchor="middle" fontSize={10} fill={MUTED}>
                    {b} block{b === "1" ? "" : "s"}
                  </text>
                </g>
              );
            })}
          </svg>
          {hover && (() => {
            const [b, i] = hover.split(":");
            const m = ms[+i];
            const gi = buckets.indexOf(b);
            return (
              <Tip x={((L + gi * gw + gw / 2) / W) * 100} y={20}>
                {label(m)}: {m.blocksToExecHist[b] ?? 0} settlements in {b} block{b === "1" ? "" : "s"}
              </Tip>
            );
          })()}
        </div>
      </figure>
    </Panel>
  );
}
