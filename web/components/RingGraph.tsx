"use client";

import type { NomadState, Ring } from "@/lib/types";
import type { PairAttempt } from "@/lib/demo";
import { STATUS, fmtNum, shortAgent, shortHash, sym, toUnits, tokenColor, type TokenIndex } from "@/lib/format";

const W = 640;
const C = W / 2;
const R = 228;
// Horizontal room for "wants X" labels of agents at 9 and 3 o'clock.
const PAD = 70;

interface Props {
  state: NomadState;
  ix: TokenIndex;
  ring: Ring | null;
  pair: PairAttempt | null;
  flash: boolean;
  showDeltas: boolean;
  dimOthers: boolean;
}

function statusLine(r: Ring): { title: string; sub: string; color: string } {
  const signed = r.signedBy.length;
  switch (r.status) {
    case "proposed":
      return { title: `Signing ${signed}/${r.k}`, sub: "each agent checks and signs only its own leg", color: "#c3c2b7" };
    case "signed":
      return { title: `All ${r.k} legs signed`, sub: "matcher adds its fee leg", color: "#c3c2b7" };
    case "simulated":
      return { title: "simulate_intents ✓", sub: "dry-run passed, submitting", color: "#c3c2b7" };
    case "submitted":
      return { title: "execute_intents →", sub: "one transaction, waiting for the block", color: STATUS.warning };
    case "settled":
      return { title: "Settled in 1 tx", sub: `${r.k} agents paid in the same block`, color: STATUS.good };
    case "failed":
      return { title: "Ring failed", sub: "nothing moved", color: STATUS.critical };
  }
}

export default function RingGraph({ state, ix, ring, pair, flash, showDeltas, dimOthers }: Props) {
  const agents = [...state.agents].sort((a, b) => a.id.localeCompare(b.id));
  const n = agents.length;
  const pos = new Map<string, { x: number; y: number; a: number }>();
  agents.forEach((ag, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pos.set(ag.id, { x: C + R * Math.cos(a), y: C + R * Math.sin(a), a });
  });

  // An agent's give/want: its live offer, else its leg in the newest ring it is in.
  const giveWant = (id: string): { give?: string; want?: string } => {
    const o = state.agents.find((a) => a.id === id)?.offers[0];
    if (o) return { give: o.give, want: o.want };
    for (const r of state.rings) {
      const l = r.legs.find((l) => l.agent === id);
      if (l) return { give: l.give, want: l.get };
    }
    return {};
  };

  const inRing = new Set(ring?.legs.map((l) => l.agent) ?? []);
  const signed = new Set(ring?.signedBy ?? []);
  const settled = ring?.status === "settled";
  const failed = ring?.status === "failed";

  // Token flow i: legs[i+1].agent gives legs[i].get to legs[i].agent.
  const flows =
    ring?.legs.map((leg, i) => {
      const giver = ring.legs[(i + 1) % ring.k].agent;
      return { from: giver, to: leg.agent, token: leg.get, amt: leg.getAmt, lit: signed.has(giver) };
    }) ?? [];

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }, pull = 0.42) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const qx = mx + (C - mx) * pull;
    const qy = my + (C - my) * pull;
    // Shorten both ends so the arrow stops at the node rim.
    const trim = (p: { x: number; y: number }, q: { x: number; y: number }, d: number) => {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const L = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / L) * d, y: p.y + (dy / L) * d };
    };
    const s = trim(a, { x: qx, y: qy }, 34);
    const e = trim(b, { x: qx, y: qy }, 36);
    // Label point at t = 0.3 along the curve (nearer the giver), so long legs' pills stay out of the centre.
    const t = 0.3;
    const at = (u: number) => ({ x: (1 - u) * (1 - u) * s.x + 2 * (1 - u) * u * qx + u * u * e.x, y: (1 - u) * (1 - u) * s.y + 2 * (1 - u) * u * qy + u * u * e.y });
    return { d: `M ${s.x} ${s.y} Q ${qx} ${qy} ${e.x} ${e.y}`, mid: at(t) };
  };

  const st = ring ? statusLine(ring) : null;

  return (
    <svg viewBox={`${-PAD} 0 ${W + 2 * PAD} ${W}`} className="w-full h-auto select-none" role="img" aria-label="Agents on a circle; the active ring is highlighted">
      <defs>
        {["#5c5b57", STATUS.good, STATUS.critical, ...state.meta.tokens.map((t) => tokenColor(ix, t.id))].map((c) => (
          <marker key={c} id={`arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        ))}
        <radialGradient id="glow">
          <stop offset="0%" stopColor={STATUS.good} stopOpacity="0.28" />
          <stop offset="100%" stopColor={STATUS.good} stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={C} cy={C} r={R} fill="none" stroke="#2c2c2a" strokeWidth={1} />
      {flash && <circle cx={C} cy={C} r={R - 30} fill="url(#glow)" className="nomad-pulse" />}

      {/* Failed pairwise attempt */}
      {pair && pos.get(pair.from) && pos.get(pair.to) && (() => {
        const c = curve(pos.get(pair.from)!, pos.get(pair.to)!, 0.25);
        return (
          <g key={`${pair.from}-${pair.to}`} className="nomad-fade-in">
            <path d={c.d} fill="none" stroke={STATUS.critical} strokeWidth={2} strokeDasharray="6 5" markerEnd={`url(#arrow-${STATUS.critical.slice(1)})`} />
            <g transform={`translate(${c.mid.x} ${c.mid.y})`}>
              <rect x={-92} y={-24} width={184} height={40} rx={8} fill="#1a1a19" stroke={STATUS.critical} strokeOpacity={0.6} />
              <text textAnchor="middle" y={-7} className="fill-[#f0efec] text-[11px]">
                {shortAgent(pair.from)} wants {pair.wantSym} from {shortAgent(pair.to)}
              </text>
              <text textAnchor="middle" y={9} className="text-[11px]" fill={STATUS.critical}>
                ✕ {shortAgent(pair.to)} doesn’t want theirs
              </text>
            </g>
          </g>
        );
      })()}

      {/* Ring legs */}
      {flows.map((f, i) => {
        const a = pos.get(f.from);
        const b = pos.get(f.to);
        if (!a || !b) return null;
        const c = curve(a, b);
        const color = failed ? STATUS.critical : settled ? STATUS.good : f.lit ? tokenColor(ix, f.token) : "#5c5b57";
        return (
          <g key={i}>
            <path
              d={c.d}
              fill="none"
              stroke={color}
              strokeWidth={f.lit || settled ? 3 : 2}
              strokeDasharray={f.lit || settled ? undefined : "4 6"}
              markerEnd={`url(#arrow-${color.slice(1)})`}
              className={settled ? "nomad-glow" : undefined}
              style={{ transition: "stroke 400ms" }}
            />
            <g transform={`translate(${c.mid.x} ${c.mid.y})`}>
              <rect x={-52} y={-11} width={104} height={22} rx={11} fill="#0d0d0d" stroke={color} strokeOpacity={0.7} />
              <text textAnchor="middle" y={4} className="fill-[#f0efec] text-[11px] font-mono">
                {fmtNum(toUnits(ix, f.token, f.amt))} {sym(ix, f.token)}
              </text>
            </g>
          </g>
        );
      })}

      {/* Agents */}
      {agents.map((ag) => {
        const p = pos.get(ag.id)!;
        const { give, want } = giveWant(ag.id);
        const active = inRing.has(ag.id);
        const dim = dimOthers && ring && !active;
        const isSigned = signed.has(ag.id);
        const ringColor = active ? (failed ? STATUS.critical : isSigned || settled ? STATUS.good : "#c3c2b7") : give ? tokenColor(ix, give) : "#5c5b57";
        const ox = Math.cos(p.a);
        const oy = Math.sin(p.a);
        const leg = ring?.legs.find((l) => l.agent === ag.id);
        return (
          <g key={ag.id} opacity={dim ? 0.28 : 1} style={{ transition: "opacity 500ms" }}>
            <title>{`${ag.id}${ag.strategy ? ` · ${ag.strategy}` : ""}`}</title>
            <circle cx={p.x} cy={p.y} r={27} fill="#1a1a19" stroke={ringColor} strokeWidth={active ? 3 : 2} />
            <text x={p.x} y={p.y - 2} textAnchor="middle" className="fill-[#f0efec] text-[13px] font-semibold">
              {shortAgent(ag.id)}
            </text>
            {give && (
              <text x={p.x} y={p.y + 13} textAnchor="middle" className="text-[10px] font-mono" fill={tokenColor(ix, give)}>
                {sym(ix, give)}
              </text>
            )}
            {active && isSigned && !settled && !failed && (
              <g transform={`translate(${p.x + 19} ${p.y - 19})`} className="nomad-fade-in">
                <circle r={9} fill={STATUS.good} />
                <text textAnchor="middle" y={4} className="fill-white text-[11px] font-bold">✓</text>
              </g>
            )}
            {/* want arrow, pointing outward */}
            {want && (
              <g transform={`translate(${p.x + ox * 44} ${p.y + oy * 44})`}>
                <text
                  textAnchor={Math.abs(ox) < 0.3 ? "middle" : ox > 0 ? "start" : "end"}
                  y={oy > 0.3 ? 10 : oy < -0.3 ? -2 : 4}
                  className="text-[11px]"
                  fill="#898781"
                >
                  wants <tspan fill={tokenColor(ix, want)} className="font-mono">{sym(ix, want)}</tspan>
                </text>
              </g>
            )}
            {showDeltas && leg && settled && (
              <g transform={`translate(${p.x - ox * 64} ${p.y - oy * 64})`} className="nomad-rise">
                <text textAnchor="middle" y={-4} className="text-[11px] font-mono" fill={STATUS.good}>
                  +{fmtNum(toUnits(ix, leg.get, leg.getAmt))} {sym(ix, leg.get)}
                </text>
                <text textAnchor="middle" y={10} className="text-[11px] font-mono" fill="#898781">
                  −{fmtNum(toUnits(ix, leg.give, leg.giveAmt))} {sym(ix, leg.give)}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Center status */}
      {ring && st ? (
        <g transform={`translate(${C} ${C})`}>
          {/* backdrop so ring edges and amount pills never run through the status text */}
          <rect x={-150} y={-44} width={300} height={ring.txHash ? 108 : 64} rx={14} fill="#121211" fillOpacity={0.92} stroke="#2c2c2a" />
          <text textAnchor="middle" y={-14} className="text-[22px] font-semibold" fill={st.color}>
            {st.title}
          </text>
          <text textAnchor="middle" y={8} className="text-[12px]" fill="#898781">
            {st.sub}
          </text>
          {ring.txHash && (
            <g className={flash ? "nomad-flash" : undefined}>
              <text textAnchor="middle" y={36} className="text-[13px] font-mono" fill="#f0efec">
                tx {shortHash(ring.txHash, 8)}
              </text>
              {ring.blockHeight != null && (
                <text textAnchor="middle" y={54} className="text-[11px] font-mono" fill="#898781">
                  block {ring.blockHeight.toLocaleString("en-US")}
                  {ring.blocksToExec != null ? ` · ${ring.blocksToExec} block${ring.blocksToExec === 1 ? "" : "s"} to execute` : ""}
                </text>
              )}
            </g>
          )}
        </g>
      ) : (
        <g transform={`translate(${C} ${C})`}>
          <text textAnchor="middle" y={-4} className="text-[15px]" fill="#898781">
            {n} agents · {state.agents.reduce((s, a) => s + a.offers.length, 0)} live offers
          </text>
          <text textAnchor="middle" y={16} className="text-[12px]" fill="#5c5b57">
            waiting for a ring with surplus
          </text>
        </g>
      )}
    </svg>
  );
}
