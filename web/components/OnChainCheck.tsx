"use client";

import { useEffect } from "react";
import type { NomadState, Ring } from "@/lib/types";
import { STATUS, fmtAmt, shortAgent, type TokenIndex } from "@/lib/format";
import { TESTNET_RPC, canRecheck, recheck, useVerification, type Diff, type Verification } from "@/lib/verify";

const n = (h: number) => h.toLocaleString("en-US");

function DiffLines({ ix, d }: { ix: TokenIndex; d: Diff | null }) {
  if (!d) return <span className="text-[#5c5b57]">nothing</span>;
  return (
    <>
      {Object.entries(d)
        .sort(([, a], [, b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .map(([t, v]) => (
          <div key={t}>{v.startsWith("-") ? `−${fmtAmt(ix, t, v.slice(1))}` : `+${fmtAmt(ix, t, v)}`}</div>
        ))}
    </>
  );
}

/** Compact control for the rings table. Clicking also selects the ring so the detail shows the full result. */
export function RecheckButton({ state, ring, onSelect }: { state: NomadState; ring: Ring; onSelect: (id: string) => void }) {
  const v = useVerification(ring.txHash);
  if (!canRecheck(state.meta.source, ring)) return null;
  const go = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(ring.ringId);
    recheck(ring);
  };
  if (v.phase === "checking") return <span className="text-[#898781]">checking…</span>;
  if (v.phase === "done") {
    const ok = v.result.allMatch;
    return (
      <button onClick={go} className="whitespace-nowrap hover:underline" style={{ color: ok ? STATUS.good : STATUS.critical }} title="Re-check on chain">
        {ok ? "✓ on chain" : "✗ mismatch"}
      </button>
    );
  }
  return (
    <button onClick={go} className="whitespace-nowrap text-[#86b6ef] hover:underline" title="Read this transaction from testnet RPC and compare it with the ring">
      {v.phase === "error" ? "retry check" : "Re-check"}
    </button>
  );
}

function Headline({ r, ring }: { r: Verification; ring: Ring }) {
  const agents = r.legs.filter((l) => l.role === "agent").length;
  if (r.success) {
    return (
      <>
        Verified on chain: {agents} agents, block {n(r.includedHeight)}
        {r.executedHeight != null && (
          <>
            , executed in block {n(r.executedHeight)} ({r.blocksToExec} block{r.blocksToExec === 1 ? "" : "s"})
          </>
        )}
        , status {r.status}.
      </>
    );
  }
  return (
    <>
      Verified on chain: the batch failed in block {n(r.includedHeight)} ({r.status.replace(/^Failure: /, "").replace(/^Smart contract panicked: /, "")}), so nothing moved for any of the {ring.k} agents.
    </>
  );
}

/** Full panel for the ring detail card. */
export function OnChainPanel({ state, ix, ring }: { state: NomadState; ix: TokenIndex; ring: Ring }) {
  const v = useVerification(ring.txHash);
  const eligible = canRecheck(state.meta.source, ring);
  // ?verify=1 runs the check on load: a shareable "verify it yourself" link.
  useEffect(() => {
    if (eligible && new URLSearchParams(window.location.search).get("verify") === "1") recheck(ring, { once: true });
  }, [eligible, ring]);
  if (!eligible) return null;

  return (
    <div className="mt-4 border-t border-white/5 pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[#898781]">Don’t trust this page: read the transaction from the chain yourself.</p>
        <button
          onClick={() => recheck(ring)}
          disabled={v.phase === "checking"}
          className="shrink-0 rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-[#f0efec] hover:border-white/40 disabled:opacity-50"
        >
          {v.phase === "checking" ? "Checking…" : v.phase === "done" ? "Check again" : "Re-check on chain"}
        </button>
      </div>

      {v.phase === "error" && (
        <p className="mt-3 rounded-md bg-[#d03b3b]/10 px-3 py-2 text-xs text-[#e66767]">✕ Couldn’t read the transaction: {v.message}</p>
      )}

      {v.phase === "done" && (() => {
        const r = v.result;
        const ok = r.allMatch;
        return (
          <div className="mt-3 flex flex-col gap-3 text-xs">
            <p
              className="rounded-md px-3 py-2 leading-relaxed"
              style={{ background: ok ? "rgba(12,163,12,0.08)" : "rgba(208,59,59,0.10)", color: ok ? "#f0efec" : "#e66767" }}
            >
              <span style={{ color: ok ? STATUS.good : STATUS.critical }}>{ok ? "✓ " : "✗ "}</span>
              <Headline r={r} ring={ring} />
              {!ok && r.success !== (ring.status === "settled") && (
                <> The ring says “{ring.status}”, but the chain says {r.success ? "it succeeded" : "it failed"}.</>
              )}
            </p>

            <table className="w-full text-left">
              <thead className="text-[#898781]">
                <tr>
                  <th className="py-1 pr-2 font-normal">Account</th>
                  <th className="py-1 pr-2 font-normal">Ring claims</th>
                  <th className="py-1 pr-2 font-normal">{r.success ? "Executed on chain" : "Signed in the tx (not executed)"}</th>
                  <th className="py-1 text-right font-normal">Match</th>
                </tr>
              </thead>
              <tbody>
                {r.legs.map((l) => (
                  <tr key={l.agent} className="border-t border-white/5 align-top">
                    <td className="py-1.5 pr-2 text-[#f0efec]" title={l.agent}>{l.role === "matcher" ? "matcher fee" : shortAgent(l.agent)}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-[#c3c2b7]">{l.claimed ? <DiffLines ix={ix} d={l.claimed} /> : "not in this ring"}</td>
                    <td className="py-1.5 pr-2 tabular-nums text-[#c3c2b7]"><DiffLines ix={ix} d={r.success ? l.executed : l.signed} /></td>
                    <td className="py-1.5 text-right" style={{ color: l.match ? STATUS.good : STATUS.critical }} aria-label={l.match ? "matches" : "does not match"}>
                      {l.match ? "✓" : "✗"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="leading-relaxed text-[#5c5b57]">
              <code className="font-mono">{r.method}</code> on {r.receiver}, signed by {r.txSigner}. Read by your browser from{" "}
              {new URL(TESTNET_RPC).host} at {new Date(r.checkedAtMs).toISOString().slice(11, 19)} UTC, not from the matcher.{" "}
              {r.success
                ? "Each row compares the ring’s leg with the signed token_diff in the transaction and with the Verifier’s token_diff event."
                : "Each row compares the ring’s leg with the signed token_diff in the transaction; the Verifier executed none of them."}
            </p>
          </div>
        );
      })()}
    </div>
  );
}
