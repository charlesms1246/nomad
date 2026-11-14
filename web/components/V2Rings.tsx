"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { STATUS, fmtAmtExact as fmtAmt, shortHash, tokenIndexOf, type TokenIndex } from "@/lib/format";
import {
  RINGS_CONTRACT,
  V2_TOKENS,
  VERIFIER,
  fetchConfig,
  fetchReputation,
  fetchRings,
  isStranger,
  recheckV2,
  shortId,
  useV2Check,
  walletOf,
  type V2Config,
  type V2Reputation,
  type V2Ring,
  type V2Verification,
} from "@/lib/v2";
import { TESTNET_RPC, type Diff } from "@/lib/verify";

const EXPLORER = "https://testnet.nearblocks.io";
const REFRESH_MS = 15_000;

// Wallet identity colours (categorical slots, dark steps), fixed per standard.
const WALLET_COLOR: Record<string, string> = { NEAR: "#3987e5", "Ethereum wallet": "#d95926", "Solana-style": "#9085e9", "ed25519 key": "#9085e9" };

const STATUS_STYLE: Record<V2Ring["status"], { c: string; icon: string; label: string }> = {
  Open: { c: "#c3c2b7", icon: "…", label: "open" },
  Closing: { c: STATUS.warning, icon: "→", label: "closing" },
  Settled: { c: STATUS.good, icon: "✓", label: "settled" },
  Failed: { c: STATUS.critical, icon: "✕", label: "close failed" },
};

const time = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const n = (h: number) => h.toLocaleString("en-US");

function Acct({ id, className = "" }: { id: string; className?: string }) {
  return (
    <a href={`${EXPLORER}/address/${id}`} target="_blank" rel="noopener noreferrer" title={id} className={`hover:underline ${className}`}>
      {shortId(id)}
    </a>
  );
}

function WalletBadge({ standard, agent }: { standard: string | null; agent: string }) {
  const w = walletOf(standard, agent);
  const c = WALLET_COLOR[w.label] ?? "#898781";
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]"
      style={{ borderColor: `${c}66`, color: "#f0efec" }}
      title={w.standard ? `Signed with the ${w.standard} standard` : "Not attached yet: wallet guessed from the account id"}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
      {w.label}
      {w.standard && <span className="text-[#898781]">{w.standard}</span>}
      {w.inferred && <span className="text-[#5c5b57]">?</span>}
    </span>
  );
}

function diffLines(ix: TokenIndex, d: Diff | null) {
  if (!d) return <span className="text-[#5c5b57]">nothing</span>;
  return Object.entries(d)
    .sort(([, a], [, b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map(([t, v]) => <div key={t}>{v.startsWith("-") ? `−${fmtAmt(ix, t, v.slice(1))}` : `+${fmtAmt(ix, t, v)}`}</div>);
}

function sumTips(ix: TokenIndex, d: Diff) {
  const e = Object.entries(d);
  return e.length ? e.map(([t, v]) => fmtAmt(ix, t, v)).join(", ") : "none";
}

function CheckResult({ ix, ring, r }: { ix: TokenIndex; ring: V2Ring; r: V2Verification }) {
  const ok = r.allMatch;
  const blocks = r.executedHeight != null ? r.executedHeight - r.includedHeight : null;
  return (
    <div className="mt-3 flex flex-col gap-3 text-xs">
      <p className="rounded-md px-3 py-2 leading-relaxed" style={{ background: ok ? "rgba(12,163,12,0.08)" : "rgba(208,59,59,0.10)", color: ok ? "#f0efec" : "#e66767" }}>
        <span style={{ color: ok ? STATUS.good : STATUS.critical }}>{ok ? "✓ " : "✗ "}</span>
        {r.success ? (
          <>
            Verified on chain: <Acct id={r.closer} className="underline decoration-white/20" />
            {r.stranger ? " (not one of the agents)" : ""} called close_ring in block {n(r.includedHeight)}. The contract’s execute_intents ran in block{" "}
            {r.executedHeight != null ? n(r.executedHeight) : "?"}
            {blocks != null ? ` (${blocks} block${blocks === 1 ? "" : "s"} later, one cross-contract hop)` : ""}, status {r.status}, settling {ring.legs.length} legs in{" "}
            {new Set(r.legs.map((l) => l.signedStandard)).size} wallet standard{new Set(r.legs.map((l) => l.signedStandard)).size === 1 ? "" : "s"}. Tips paid to the closer: {sumTips(ix, r.tipsPaid)}.
          </>
        ) : (
          <>Verified on chain: this close attempt’s execute_intents failed ({r.status.replace(/^Failure: (Smart contract panicked: )?/, "")}), so nothing moved for any agent.</>
        )}
        {!ok && r.success !== (ring.status === "Settled") && <> The contract says “{ring.status}”, but the chain says the batch {r.success ? "succeeded" : "failed"}.</>}
      </p>
      <table className="w-full text-left">
        <thead className="text-[#898781]">
          <tr>
            <th className="py-1 pr-2 font-normal">Leg</th>
            <th className="py-1 pr-2 font-normal">Signed as</th>
            <th className="py-1 pr-2 font-normal">Ring says</th>
            <th className="py-1 pr-2 font-normal">{r.success ? "Executed on chain" : "Signed (not executed)"}</th>
            <th className="py-1 pr-2 font-normal">Tip signed to the contract</th>
            <th className="py-1 text-right font-normal">Match</th>
          </tr>
        </thead>
        <tbody>
          {r.legs.map((l) => (
            <tr key={l.index} className="border-t border-white/5 align-top">
              <td className="py-1.5 pr-2 text-[#f0efec]" title={l.agent}>{shortId(l.agent)}</td>
              <td className="py-1.5 pr-2 text-[#c3c2b7]">{l.signedStandard ?? "not found in the batch"}</td>
              <td className="py-1.5 pr-2 tabular-nums text-[#c3c2b7]">{diffLines(ix, l.claimed)}</td>
              <td className="py-1.5 pr-2 tabular-nums text-[#c3c2b7]">{diffLines(ix, r.success ? l.executed : l.signed)}</td>
              <td className="py-1.5 pr-2 text-[#c3c2b7]">{l.tipClaimed ? `${l.tipSigned ? "✓" : "✗"} ${fmtAmt(ix, l.tipClaimed.token, l.tipClaimed.amt)}` : "no tip"}</td>
              <td className="py-1.5 text-right" style={{ color: l.match ? STATUS.good : STATUS.critical }}>{l.match ? "✓" : "✗"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="leading-relaxed text-[#5c5b57]">
        Close tx{" "}
        <a href={`${EXPLORER}/txns/${r.txHash}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[#86b6ef] hover:underline">
          {shortHash(r.txHash, 6)} ↗
        </a>
        , found through NearBlocks and then read by your browser from {new URL(TESTNET_RPC).host} at {time(r.checkedAtMs).slice(11)}. Each row compares the contract’s leg with the signed
        payload inside the execute_intents receipt (decoded per wallet standard) and with the Verifier’s token_diff event.
      </p>
    </div>
  );
}

function RingCard({ ix, ring, auto }: { ix: TokenIndex; ring: V2Ring; auto: boolean }) {
  const v = useV2Check(ring.id);
  const s = STATUS_STYLE[ring.status];
  const closed = ring.status === "Settled" || ring.status === "Failed";
  const stranger = isStranger(ring);
  const tips: Diff = {};
  for (const l of ring.legs) if (l.tip) tips[l.tip.token] = (BigInt(tips[l.tip.token] ?? "0") + BigInt(l.tip.amt)).toString();
  const attached = ring.signed.filter(Boolean).length;
  const [paste, setPaste] = useState("");

  useEffect(() => {
    if (auto && closed && v.phase === "idle") recheckV2(ring);
  }, [auto, closed, v.phase, ring]);

  return (
    <article className="rounded-xl border border-white/10 bg-[#1a1a19] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="flex items-baseline gap-3 text-sm">
          <span style={{ color: s.c }}>
            {s.icon} {s.label}
          </span>
          <span className="text-[#c3c2b7]">
            Ring <span className="font-mono text-[#f0efec]">{ring.id.slice(0, 10)}</span>
          </span>
          <span className="text-xs text-[#5c5b57]">{time(ring.created_ms)}</span>
        </h3>
        <p className="text-xs text-[#898781]">
          proposed by <Acct id={ring.proposer} className="text-[#c3c2b7]" />
          {ring.closer && (
            <>
              {" "}
              · closed by <Acct id={ring.closer} className="text-[#f0efec]" />
            </>
          )}
          {stranger && (
            <span className="ml-2 rounded-full border border-[#0ca30c]/50 bg-[#0ca30c]/10 px-2 py-0.5 text-[11px] font-medium text-[#0ca30c]" title="The closer is not one of the ring's agents">
              closed by a stranger
            </span>
          )}
        </p>
      </header>

      <table className="mt-4 w-full text-left text-xs">
        <thead className="text-[#898781]">
          <tr className="border-b border-white/5">
            <th className="py-1.5 pr-3 font-normal">Agent</th>
            <th className="py-1.5 pr-3 font-normal">Wallet</th>
            <th className="py-1.5 pr-3 font-normal">Gives</th>
            <th className="py-1.5 pr-3 font-normal">Gets</th>
            <th className="py-1.5 pr-3 font-normal">Tip to the closer</th>
            <th className="py-1.5 text-right font-normal">Leg signed</th>
          </tr>
        </thead>
        <tbody>
          {ring.legs.map((l, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0">
              <td className="py-2 pr-3 text-[#f0efec]">
                <Acct id={l.agent} />
              </td>
              <td className="py-2 pr-3">
                <WalletBadge standard={ring.standards[i] ?? null} agent={l.agent} />
              </td>
              <td className="py-2 pr-3 tabular-nums text-[#c3c2b7]" title={fmtAmt(ix, l.give, l.give_amt, 99)}>{fmtAmt(ix, l.give, l.give_amt)}</td>
              <td className="py-2 pr-3 tabular-nums text-[#c3c2b7]" title={fmtAmt(ix, l.get, l.get_amt, 99)}>{fmtAmt(ix, l.get, l.get_amt)}</td>
              <td className="py-2 pr-3 tabular-nums text-[#898781]">{l.tip ? fmtAmt(ix, l.tip.token, l.tip.amt) : "none"}</td>
              <td className="py-2 text-right" style={{ color: ring.signed[i] ? STATUS.good : "#5c5b57" }}>
                {ring.signed[i] ? "✓" : "waiting"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[#898781]">
        <span>
          {attached}/{ring.legs.length} legs attached · tips {ring.status === "Settled" ? "paid" : "offered"}: {sumTips(ix, tips)}
          {ring.close_attempts > 1 ? ` · ${ring.close_attempts} close attempts` : ""}
          {ring.status === "Open" ? ` · expires ${time(ring.deadline_ms).slice(11)}` : ""}
        </span>
        {closed && (
          <button
            onClick={() => recheckV2(ring)}
            disabled={v.phase === "checking"}
            className="rounded-full border border-white/15 px-3 py-1 font-medium text-[#f0efec] hover:border-white/40 disabled:opacity-50"
          >
            {v.phase === "checking" ? "Checking…" : v.phase === "done" ? "Check again" : "Re-check the close on chain"}
          </button>
        )}
      </div>

      {v.phase === "error" && (
        <div className="mt-3 flex flex-col gap-2 text-xs">
          <p className="rounded-md bg-[#d03b3b]/10 px-3 py-2 text-[#e66767]">✕ Couldn’t check: {v.message}</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (paste.trim() && ring.closer) recheckV2(ring, { hash: paste.trim(), sender: ring.closer });
            }}
          >
            <input
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Paste the close_ring tx hash"
              className="flex-1 rounded-md border border-white/10 bg-[#0d0d0d] px-2 py-1 font-mono text-[#f0efec] placeholder:font-sans placeholder:text-[#5c5b57]"
            />
            <button className="rounded-md border border-white/15 px-3 py-1 text-[#f0efec] hover:border-white/40">Check</button>
          </form>
        </div>
      )}
      {v.phase === "done" && <CheckResult ix={ix} ring={ring} r={v.result} />}
    </article>
  );
}

function ReputationTable({ rings }: { rings: V2Ring[] }) {
  const ids = useMemo(() => {
    const s = new Set<string>();
    for (const r of rings) {
      r.legs.forEach((l) => s.add(l.agent));
      if (r.closer) s.add(r.closer);
    }
    return [...s];
  }, [rings]);
  const stdOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of rings) r.legs.forEach((l, i) => r.standards[i] && m.set(l.agent, r.standards[i]));
    return m;
  }, [rings]);
  const [rep, setRep] = useState<Record<string, V2Reputation>>({});
  const key = ids.join(",");
  useEffect(() => {
    let stop = false;
    Promise.all(ids.map(async (a) => [a, await fetchReputation(a)] as const)).then(
      (rows) => !stop && setRep(Object.fromEntries(rows)),
      () => {},
    );
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const rows = ids
    .map((a) => ({ a, r: rep[a] }))
    .filter((x) => x.r)
    .sort((x, y) => y.r!.rings_settled + y.r!.rings_closed - (x.r!.rings_settled + x.r!.rings_closed) || x.a.localeCompare(y.a));

  return (
    <section className="rounded-xl border border-white/10 bg-[#1a1a19] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-[#c3c2b7]">Reputation</h2>
        <p className="text-[11px] text-[#898781]">Written only by the contract when a close succeeds or fails · view reputation(agent)</p>
      </header>
      <table className="mt-3 w-full text-left text-xs">
        <thead className="text-[#898781]">
          <tr className="border-b border-white/5">
            <th className="py-1.5 pr-3 font-normal">Account</th>
            <th className="py-1.5 pr-3 font-normal">Wallet</th>
            <th className="py-1.5 pr-3 text-right font-normal">Rings settled (as an agent)</th>
            <th className="py-1.5 pr-3 text-right font-normal">Rings closed</th>
            <th className="py-1.5 text-right font-normal">Legs in failed closes</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-[#5c5b57]">
                Loading…
              </td>
            </tr>
          )}
          {rows.map(({ a, r }) => (
            <tr key={a} className="border-b border-white/5 last:border-0">
              <td className="py-2 pr-3 text-[#f0efec]">
                <Acct id={a} />
              </td>
              <td className="py-2 pr-3">
                <WalletBadge standard={stdOf.get(a) ?? null} agent={a} />
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-[#f0efec]">{r!.rings_settled}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-[#f0efec]">{r!.rings_closed}</td>
              <td className="py-2 text-right tabular-nums" style={{ color: r!.legs_in_failed_closes ? STATUS.critical : "#f0efec" }}>
                {r!.legs_in_failed_closes}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function V2Rings() {
  const ix = useMemo(() => tokenIndexOf(V2_TOKENS), []);
  const [rings, setRings] = useState<V2Ring[] | null>(null);
  const [cfg, setCfg] = useState<V2Config | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([fetchRings(0, 20), fetchConfig()]);
      setRings(r);
      setCfg(c);
      setErr(null);
      setLoadedAt(Date.now());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // ?verify=1 re-checks every closed ring on load (a shareable "verify it yourself" link).
    const verify = new URLSearchParams(window.location.search).get("verify") === "1";
    const t0 = setTimeout(() => {
      setAuto(verify);
      load();
    }, 0);
    const id = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [load]);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-5 py-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#f0efec]">
            Nomad v2 <span className="font-normal text-[#898781]">· open rings, any wallet</span>
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[#898781]">
            Anyone proposes a ring. Each agent attaches its own signed leg, from a NEAR account, an Ethereum wallet or a Solana-style key. Anyone can close the ring:
            one execute_intents settles every leg or none, and the closer earns the legs’ tips.
          </p>
          <p className="mt-2 text-xs text-[#898781]">
            Contract <Acct id={RINGS_CONTRACT} className="text-[#c3c2b7] underline decoration-white/20" /> · Verifier{" "}
            <Acct id={VERIFIER} className="text-[#c3c2b7] underline decoration-white/20" />
            {cfg && (
              <>
                {" "}
                · {cfg.rings} rings proposed, {cfg.settled} settled · Verifier fee {cfg.fee_pips} pip{cfg.fee_pips === 1 ? "" : "s"}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-[#fab219]/40 px-2.5 py-1 font-medium uppercase tracking-wide text-[#fab219]">NEAR testnet</span>
          <span
            className="flex items-center gap-1.5 rounded-full border border-[#0ca30c]/50 px-2.5 py-1 font-medium uppercase tracking-wide text-[#0ca30c]"
            title="Read by your browser from testnet RPC; no Nomad server in between"
          >
            <span className="nomad-dot h-1.5 w-1.5 rounded-full bg-[#0ca30c]" /> Live from chain
          </span>
          <button onClick={load} className="rounded-full border border-white/15 px-3 py-1 text-xs text-[#f0efec] hover:border-white/40">
            Refresh
          </button>
          <Link href="/" className="rounded-full bg-[#f0efec] px-3.5 py-1.5 text-xs font-semibold text-[#0d0d0d] hover:bg-white">
            ← Matcher dashboard
          </Link>
        </div>
      </header>

      {err && <p className="rounded-md bg-[#d03b3b]/10 px-3 py-2 text-xs text-[#e66767]">✕ Couldn’t read {RINGS_CONTRACT}: {err}</p>}
      {!rings && !err && <p className="text-sm text-[#898781]">Reading rings from testnet…</p>}

      {rings && (
        <>
          <section className="flex flex-col gap-4">
            <header className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-[#c3c2b7]">Rings, newest first</h2>
              {loadedAt && <p className="text-[11px] text-[#5c5b57]">view rings(0, 20) · read {time(loadedAt).slice(11)}</p>}
            </header>
            {rings.length === 0 && <p className="text-sm text-[#898781]">No rings yet.</p>}
            {rings.map((r) => (
              <RingCard key={r.id} ix={ix} ring={r} auto={auto} />
            ))}
          </section>
          <ReputationTable rings={rings} />
        </>
      )}
    </div>
  );
}
