"use client";

import type { NomadState, Ring } from "@/lib/types";
import { STATUS, fmtBps, fmtUsd, shortAgent, sym, type TokenIndex } from "@/lib/format";
import { TxLink } from "./RingDetail";
import { RecheckButton } from "./OnChainCheck";

const STATUS_STYLE: Record<Ring["status"], { c: string; icon: string }> = {
  proposed: { c: "#c3c2b7", icon: "…" },
  signed: { c: "#c3c2b7", icon: "✎" },
  simulated: { c: "#c3c2b7", icon: "◇" },
  submitted: { c: STATUS.warning, icon: "→" },
  settled: { c: STATUS.good, icon: "✓" },
  failed: { c: STATUS.critical, icon: "✕" },
};

export default function RingsTable({
  state,
  ix,
  selected,
  onSelect,
}: {
  state: NomadState;
  ix: TokenIndex;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const settled = state.rings.filter((r) => r.status === "settled");
  const withSav = settled.filter((r) => r.savingsBps != null);
  const meanSav = withSav.length ? withSav.reduce((s, r) => s + r.savingsBps!, 0) / withSav.length : null;
  const totUsd = withSav.reduce((s, r) => s + (r.savingsUsd ?? 0), 0);

  return (
    <section className="rounded-xl border border-white/10 bg-[#1a1a19]">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <h2 className="text-sm font-medium text-[#c3c2b7]">Rings</h2>
        <p className="text-xs text-[#898781]">
          {settled.length} settled · {state.rings.length - settled.length} other · mean saving {fmtBps(meanSav)} · {fmtUsd(totUsd)} total
        </p>
      </header>
      <div className="overflow-x-auto px-2 pb-3 pt-2">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="text-[#898781]">
            <tr className="border-b border-white/5">
              <th className="px-3 py-2 font-normal">Ring</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 text-right font-normal">k</th>
              <th className="px-3 py-2 font-normal">Legs</th>
              <th className="px-3 py-2 text-right font-normal">Surplus</th>
              <th className="px-3 py-2 text-right font-normal">Matcher</th>
              <th className="px-3 py-2 text-right font-normal">vs 1Click</th>
              <th className="px-3 py-2 text-right font-normal">USD</th>
              <th className="px-3 py-2 font-normal">Tx</th>
              <th className="px-3 py-2 text-right font-normal">Blocks</th>
            </tr>
          </thead>
          <tbody>
            {state.rings.map((r) => {
              const s = STATUS_STYLE[r.status];
              const isSel = selected === r.ringId;
              return (
                <tr
                  key={r.ringId}
                  onClick={() => onSelect(isSel ? null : r.ringId)}
                  className={`cursor-pointer border-b border-white/5 last:border-0 hover:bg-white/[.03] ${isSel ? "bg-white/[.05]" : ""}`}
                  title={r.error ?? undefined}
                >
                  <td className="px-3 py-2 font-mono text-[#f0efec]">{r.ringId.slice(0, 8)}</td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: s.c }}>
                    {s.icon} {r.status}
                    {r.status === "proposed" ? ` ${r.signedBy.length}/${r.k}` : ""}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#f0efec]">{r.k}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#c3c2b7]">
                    {r.legs.map((l, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-[#5c5b57]"> · </span>}
                        {shortAgent(l.agent)} <span className="font-mono text-[#898781]">{sym(ix, l.give)}→{sym(ix, l.get)}</span>
                      </span>
                    ))}
                    <span className="text-[#5c5b57]"> · {shortAgent(r.matcher)}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[#f0efec]">{fmtBps(r.surplusBps, 0)}</td>
                  <td className="px-3 py-2 text-right font-mono text-[#c3c2b7]">{fmtBps(r.matcherShareBps, 0)}</td>
                  <td className="px-3 py-2 text-right font-mono" style={{ color: r.savingsBps != null ? STATUS.good : "#5c5b57" }}>
                    {r.savingsBps != null ? `+${r.savingsBps.toFixed(1)} bps` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[#c3c2b7]">{fmtUsd(r.savingsUsd)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <TxLink state={state} hash={r.txHash} n={6} />
                    <div className="mt-0.5">
                      <RecheckButton state={state} ring={r} onSelect={onSelect} />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#f0efec]">{r.blocksToExec ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
