"use client";

import type { NomadState, Ring } from "@/lib/types";
import { STATUS, fmtAmt, fmtBps, fmtTime, fmtUsd, shortAgent, shortHash, type TokenIndex } from "@/lib/format";

const STEPS: { key: Ring["status"]; label: string }[] = [
  { key: "proposed", label: "proposed" },
  { key: "signed", label: "legs signed" },
  { key: "simulated", label: "simulate_intents" },
  { key: "submitted", label: "execute_intents" },
  { key: "settled", label: "settled" },
];

export function TxLink({ state, hash, n = 8 }: { state: NomadState; hash: string | null; n?: number }) {
  if (!hash) return <span className="text-[#5c5b57]">—</span>;
  if (state.meta.source === "mock") {
    return (
      <span className="font-mono text-[#c3c2b7]" title="Mock data: not a real transaction">
        {shortHash(hash, n)} <span className="text-[10px] text-[#898781]">(mock)</span>
      </span>
    );
  }
  return (
    <a
      href={`${state.meta.explorerTxUrl}${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[#86b6ef] underline decoration-[#86b6ef]/40 underline-offset-2 hover:decoration-[#86b6ef]"
    >
      {shortHash(hash, n)} ↗
    </a>
  );
}

export default function RingDetail({ state, ix, ring, highlightSavings }: { state: NomadState; ix: TokenIndex; ring: Ring | null; highlightSavings: boolean }) {
  if (!ring) {
    return <div className="rounded-xl border border-white/10 bg-[#1a1a19] p-5 text-sm text-[#898781]">No ring yet. The matcher proposes one when it finds a loop with surplus.</div>;
  }
  const idx = ring.status === "failed" ? -1 : STEPS.findIndex((s) => s.key === ring.status);
  const signed = new Set(ring.signedBy);
  const base = state.meta.baseline;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-white/10 bg-[#1a1a19] p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-[#c3c2b7]">
            Ring <span className="font-mono text-[#f0efec]">{ring.ringId.slice(0, 10)}</span>
          </h2>
          <span className="text-xs text-[#898781]">
            k = {ring.k} · matcher {shortAgent(ring.matcher)}
          </span>
        </div>

        <ol className="mt-4 flex items-center gap-1 text-[11px]">
          {STEPS.map((s, i) => {
            const done = idx >= i;
            return (
              <li key={s.key} className="flex flex-1 flex-col gap-1">
                <span className="h-1 rounded-full" style={{ background: ring.status === "failed" ? STATUS.critical : done ? STATUS.good : "#2c2c2a", transition: "background 400ms" }} />
                <span className={done ? "text-[#c3c2b7]" : "text-[#5c5b57]"}>{s.label}</span>
              </li>
            );
          })}
        </ol>

        <ul className="mt-4 flex flex-col gap-2 text-sm">
          {ring.legs.map((l) => (
            <li key={l.agent} className="flex items-center gap-3">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                style={{ background: signed.has(l.agent) ? STATUS.good : "#2c2c2a", color: "#fff", transition: "background 400ms" }}
                aria-label={signed.has(l.agent) ? "signed" : "not signed yet"}
              >
                {signed.has(l.agent) ? "✓" : ""}
              </span>
              <span className="w-10 font-semibold text-[#f0efec]">{shortAgent(l.agent)}</span>
              <span className="font-mono text-[13px] text-[#c3c2b7]">
                −{fmtAmt(ix, l.give, l.giveAmt)} <span className="text-[#5c5b57]">→</span> +{fmtAmt(ix, l.get, l.getAmt)}
              </span>
            </li>
          ))}
          <li className="flex items-center gap-3 border-t border-white/5 pt-2">
            <span className="h-5 w-5 shrink-0" />
            <span className="w-10 text-[#898781]">fee</span>
            <span className="font-mono text-[13px] text-[#898781]">
              matcher +{fmtAmt(ix, ring.matcherLeg.token, ring.matcherLeg.amt)} (positive-only leg, same batch)
            </span>
          </li>
        </ul>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <dt className="text-[#898781]">Surplus</dt>
          <dd className="text-right font-mono text-[#f0efec]">{fmtBps(ring.surplusBps, 0)}</dd>
          <dt className="text-[#898781]">Matcher share</dt>
          <dd className="text-right font-mono text-[#f0efec]">{fmtBps(ring.matcherShareBps, 0)}</dd>
          <dt className="text-[#898781]">Transaction</dt>
          <dd className="text-right">
            <TxLink state={state} hash={ring.txHash} />
          </dd>
          <dt className="text-[#898781]">Blocks to execute</dt>
          <dd className="text-right font-mono text-[#f0efec]">{ring.blocksToExec ?? "—"}</dd>
          <dt className="text-[#898781]">Gas burnt</dt>
          <dd className="text-right font-mono text-[#f0efec]">{ring.gasBurntTgas != null ? `${ring.gasBurntTgas} Tgas` : "—"}</dd>
        </dl>
        {ring.error && <p className="mt-3 rounded-md bg-[#d03b3b]/10 px-3 py-2 text-xs text-[#e66767]">✕ {ring.error}</p>}
      </div>

      <div
        className={`rounded-xl border p-5 transition-colors duration-500 ${highlightSavings ? "border-[#0ca30c]/60 bg-[#0ca30c]/[.07]" : "border-white/10 bg-[#1a1a19]"}`}
      >
        <h2 className="text-sm font-medium text-[#c3c2b7]">Ring vs 1Click</h2>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[#898781]">1Click spread</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-[#ec835a]">{base ? `−${base.bps} bps` : "—"}</div>
            <div className="mt-1 text-[11px] text-[#898781]">{base ? `${base.pair}, mainnet dry quote, ${fmtTime(base.quotedAtMs)}` : "no quote yet"}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[#898781]">This ring saved</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: ring.savingsBps != null ? STATUS.good : "#5c5b57" }}>
              {ring.savingsBps != null ? `+${ring.savingsBps.toFixed(1)} bps` : "—"}
            </div>
            <div className="mt-1 text-[11px] text-[#898781]">
              {ring.savingsUsd != null ? `${fmtUsd(ring.savingsUsd)} across ${ring.k} legs` : "measured at settlement"}
              {ring.baselineQuotedAtMs && ring.savingsBps != null ? `, quotes ${fmtTime(ring.baselineQuotedAtMs)}` : ""}
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#5c5b57]">
          Savings compare each leg with a same-time 1Click mainnet dry quote for the same amount. The ring itself settles on testnet.
        </p>
      </div>
    </div>
  );
}
