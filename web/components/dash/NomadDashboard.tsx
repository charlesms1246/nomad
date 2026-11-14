"use client";

// The matcher dashboard, laid out like Talos's operator view and coloured like the landing page:
// the agents' workshop up top, a quiet status line, then tabs for ring events, settled rings,
// agent balances and reputation. Every figure comes from GET /api/state (the matcher, or the
// recorded testnet state when the matcher is offline); nothing here is typed in by hand.

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NomadState, Ring } from "@/lib/types";
import { fmtAmtExact, shortAgent, shortHash, sym, tokenColor, tokenIndex, toUnits, type TokenIndex } from "@/lib/format";
import WorkshopSlot from "./WorkshopSlot";
import LogoMark from "@/components/LogoMark";

const ease = [0.22, 1, 0.36, 1] as const;
const POLL_MS = 2000;

const TABS = ["Ring events", "Settled on chain", "Agent balances", "Reputation"] as const;
type Tab = (typeof TABS)[number];

// Times in UTC, so a recorded snapshot reads the same everywhere.
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
const dateTime = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/**
 * Several matchers race to settle the same signed legs. The Verifier accepts each signed nonce once, so the
 * slower submissions panic with "nonce was already used": nothing moves. Those are lost races, not failures.
 */
const isLostRace = (r: Ring) => r.status === "failed" && /nonce was already used/i.test(r.error ?? "");

/** The Verifier's or matcher's reason, without the generic wrapper, in plain words. */
function reasonOf(error: string | null): string {
  if (!error) return "no reason recorded";
  const declined = /^declined: ([^ ]+) \((.+)\)$/.exec(error);
  if (declined) return `${shortAgent(declined[1])} declined to sign: ${declined[2]}`;
  return error.replace(/^execute: /, "").replace(/^Smart contract panicked: /, "Verifier: ");
}

function Panel({ title, right, children, className = "", delay = 0 }: { title: string; right?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.6, ease }}
      className={`motion-static flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111110]/85 backdrop-blur-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <h2 className="text-sm font-medium text-[#f0efec]">{title}</h2>
        {right && <div className="text-sm text-[#898781]">{right}</div>}
      </div>
      {children}
    </motion.section>
  );
}

// ---------- ring events (Talos event-stream) ----------

interface Ev {
  key: string;
  t: number;
  tone: "info" | "good" | "bad" | "lost";
  title: string;
  detail: string;
  tx?: string;
}

function eventsOf(rings: Ring[]): Ev[] {
  const out: Ev[] = [];
  for (const r of rings) {
    const m = shortAgent(r.matcher);
    out.push({ key: `${r.ringId}-p`, t: r.proposedAtMs, tone: "info", title: `Ring of ${r.k} from ${m}`, detail: r.legs.map((l) => shortAgent(l.agent)).join(", ") });
    if (r.signedBy.length)
      out.push({
        key: `${r.ringId}-s`,
        t: r.proposedAtMs + 1,
        tone: "info",
        title: r.signedBy.length === r.k ? `All ${r.k} legs signed` : `${r.signedBy.length} of ${r.k} legs signed`,
        detail: `for ${m}`,
      });
    if (r.status === "settled")
      out.push({
        key: `${r.ringId}-x`,
        t: r.settledAtMs ?? r.proposedAtMs + 2,
        tone: "good",
        title: `Settled by ${m}`,
        detail: `block ${r.blockHeight?.toLocaleString("en-US") ?? "unknown"}${r.blocksToExec != null ? `, ${r.blocksToExec}-block wait` : ""}`,
        tx: r.txHash ?? undefined,
      });
    if (r.status === "failed")
      out.push({
        key: `${r.ringId}-f`,
        t: r.settledAtMs ?? r.proposedAtMs + 2,
        tone: isLostRace(r) ? "lost" : "bad",
        title: isLostRace(r) ? `${m} lost the race` : `Failed for ${m}`,
        detail: reasonOf(r.error),
        tx: r.txHash ?? undefined,
      });
  }
  return out.sort((a, b) => b.t - a.t);
}

const TONE = { info: "#898781", good: "#0ca30c", bad: "#d03b3b", lost: "#c98500" };

function EventStream({ state, limit }: { state: NomadState; limit?: number }) {
  const all = useMemo(() => eventsOf(state.rings), [state.rings]);
  const evs = limit ? all.slice(0, limit) : all;
  if (!evs.length) return <p className="px-5 py-10 text-center text-sm text-[#898781]">No rings yet.</p>;
  return (
    <ol className="divide-y divide-white/5">
      <AnimatePresence initial={false}>
        {evs.map((e) => (
          <motion.li
            key={e.key}
            layout="position"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, ease }}
            className="motion-static flex items-start gap-3 px-5 py-3"
          >
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: TONE[e.tone] }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[#f0efec]">{e.title}</p>
              <p className="break-words text-sm text-[#898781]">
                {e.detail}
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-[#5c5b57]">{clock(e.t)}</span>
            {e.tx && (
              <a
                href={state.meta.explorerTxUrl + e.tx}
                target="_blank"
                rel="noopener noreferrer"
                title={`Transaction ${e.tx}`}
                className="shrink-0 text-[#898781] transition-colors hover:text-[var(--accent-color)]"
              >
                <ArrowUpRight size={16} />
              </a>
            )}
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

// ---------- settled on chain (Talos onchain-stream) ----------

function LegLine({ ix, l }: { ix: TokenIndex; l: Ring["legs"][number] }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <span className="w-12 shrink-0 text-[#f0efec]">{shortAgent(l.agent)}</span>
      <span className="text-[#898781]">gave</span>
      <span style={{ color: tokenColor(ix, l.give) }}>{fmtAmtExact(ix, l.give, l.giveAmt, 6)}</span>
      <span className="text-[#898781]">and got</span>
      <span style={{ color: tokenColor(ix, l.get) }}>{fmtAmtExact(ix, l.get, l.getAmt, 6)}</span>
    </li>
  );
}

function SettledRings({ state, ix }: { state: NomadState; ix: TokenIndex }) {
  const settled = state.rings.filter((r) => r.status === "settled" && r.txHash);
  if (!settled.length) return <p className="px-5 py-10 text-center text-sm text-[#898781]">No settled rings yet.</p>;
  return (
    <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
      {settled.map((r, i) => (
        <motion.a
          key={r.ringId}
          href={state.meta.explorerTxUrl + r.txHash}
          target="_blank"
          rel="noopener noreferrer"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.5, ease }}
          className="motion-static group flex flex-col gap-3 rounded-xl border border-white/10 bg-[#0d0d0d]/80 p-5 transition-colors duration-200 hover:border-[var(--accent-color)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-medium text-[#f0efec]">
                {r.k} agents, one transaction
              </p>
              <p className="text-sm text-[#898781]">
                {r.settledAtMs ? dateTime(r.settledAtMs) : ""}
                {r.blockHeight ? ` · block ${r.blockHeight.toLocaleString("en-US")}` : ""}
                {r.blocksToExec != null ? ` · ${r.blocksToExec} block${r.blocksToExec === 1 ? "" : "s"} to run` : ""}
              </p>
            </div>
            <ArrowUpRight size={18} className="shrink-0 text-[#898781] transition-colors group-hover:text-[var(--accent-color)]" />
          </div>
          <ul className="flex flex-col gap-1">
            {r.legs.map((l) => (
              <LegLine key={l.agent + l.give} ix={ix} l={l} />
            ))}
          </ul>
          <p className="text-sm text-[#898781]">
            Matcher {shortAgent(r.matcher)} kept {fmtAmtExact(ix, r.matcherLeg.token, r.matcherLeg.amt, 6)}
            {r.savingsBps != null ? `. Legs did ${(r.savingsBps / 100).toFixed(2)}% better than a 1Click quote at the time` : ""}
            {r.gasBurntTgas != null ? `. ${r.gasBurntTgas} Tgas` : ""}. Transaction {shortHash(r.txHash!, 6)}.
          </p>
        </motion.a>
      ))}
    </div>
  );
}

// ---------- agent balances (Talos portfolio-panel) ----------

function Balances({ state, ix }: { state: NomadState; ix: TokenIndex }) {
  const tokens = state.meta.tokens;
  const usdOf = (h: Record<string, string>) => {
    let sum = 0;
    for (const t of tokens) {
      if (t.priceUsd == null) return null;
      sum += toUnits(ix, t.id, h[t.id] ?? "0") * t.priceUsd;
    }
    return sum;
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="text-[#898781]">
          <tr className="border-b border-white/10">
            <th className="px-5 py-3 font-normal">Agent</th>
            {tokens.map((t) => (
              <th key={t.id} className="px-3 py-3 text-right font-normal">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: tokenColor(ix, t.id) }} />
                {t.symbol}
              </th>
            ))}
            <th className="px-3 py-3 text-right font-normal">About, in USD</th>
            <th className="px-5 py-3 text-right font-normal">Open offers</th>
          </tr>
        </thead>
        <tbody>
          {state.agents.map((a) => {
            const usd = usdOf(a.holdings);
            return (
              <tr key={a.id} className="border-b border-white/5 transition-colors hover:bg-white/[0.03]">
                <td className="px-5 py-2.5">
                  <span className="text-[#f0efec]">{shortAgent(a.id)}</span>
                  {a.strategy && <span className="ml-2 text-[#5c5b57]">{a.strategy}</span>}
                </td>
                {tokens.map((t) => {
                  const v = a.holdings[t.id] ?? "0";
                  return (
                    <td key={t.id} className={`px-3 py-2.5 text-right tabular-nums ${v === "0" ? "text-[#5c5b57]" : "text-[#c3c2b7]"}`}>
                      {v === "0" ? "0" : fmtAmtExact(ix, t.id, v, 6).replace(` ${sym(ix, t.id)}`, "")}
                    </td>
                  );
                })}
                <td className="px-3 py-2.5 text-right tabular-nums text-[#f0efec]">
                  {usd == null ? "unknown" : `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-[#c3c2b7]">{a.offers.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-5 py-3 text-sm text-[#5c5b57]">
        Balances held in the Verifier ({state.meta.verifier}). USD uses the 1Click mid price in the state feed.
      </p>
    </div>
  );
}

// ---------- reputation ----------

function Reputation({ state }: { state: NomadState }) {
  const rows = useMemo(() => {
    const m = new Map<string, { joined: number; signed: number; settled: number; lost: number; failed: number }>();
    for (const a of state.agents) m.set(a.id, { joined: 0, signed: 0, settled: 0, lost: 0, failed: 0 });
    for (const r of state.rings)
      for (const l of r.legs) {
        const row = m.get(l.agent) ?? { joined: 0, signed: 0, settled: 0, lost: 0, failed: 0 };
        row.joined++;
        if (r.signedBy.includes(l.agent)) row.signed++;
        if (r.status === "settled") row.settled++;
        if (isLostRace(r)) row.lost++;
        else if (r.status === "failed") row.failed++;
        m.set(l.agent, row);
      }
    return [...m.entries()].sort((a, b) => b[1].settled - a[1].settled || b[1].joined - a[1].joined);
  }, [state]);
  const max = Math.max(1, ...rows.map(([, r]) => r.joined));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-left text-sm">
        <thead className="text-[#898781]">
          <tr className="border-b border-white/10">
            <th className="px-5 py-3 font-normal">Agent</th>
            <th className="px-3 py-3 font-normal">Rings joined</th>
            <th className="px-3 py-3 text-right font-normal">Signed its leg</th>
            <th className="px-3 py-3 text-right font-normal">Settled</th>
            <th className="px-3 py-3 text-right font-normal">Lost races</th>
            <th className="px-5 py-3 text-right font-normal">Failed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, r]) => (
            <tr key={id} className="border-b border-white/5 transition-colors hover:bg-white/[0.03]">
              <td className="px-5 py-2.5 text-[#f0efec]">{shortAgent(id)}</td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-2 w-40 gap-[2px] overflow-hidden rounded-full bg-white/5">
                    <motion.div
                      className="motion-static h-full rounded-full bg-[#0ca30c]"
                      initial={{ width: 0 }}
                      animate={{ width: `${(r.settled / max) * 100}%` }}
                      transition={{ duration: 0.8, ease }}
                    />
                    <motion.div
                      className="motion-static h-full rounded-full bg-[#c98500]"
                      initial={{ width: 0 }}
                      animate={{ width: `${(r.lost / max) * 100}%` }}
                      transition={{ duration: 0.8, ease }}
                    />
                    <motion.div
                      className="motion-static h-full rounded-full bg-[#d03b3b]"
                      initial={{ width: 0 }}
                      animate={{ width: `${(r.failed / max) * 100}%` }}
                      transition={{ duration: 0.8, ease }}
                    />
                  </div>
                  <span className="tabular-nums text-[#c3c2b7]">{r.joined}</span>
                </div>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-[#c3c2b7]">{r.signed}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-[#0ca30c]">{r.settled}</td>
              <td className={`px-3 py-2.5 text-right tabular-nums ${r.lost ? "text-[#c98500]" : "text-[#5c5b57]"}`}>{r.lost}</td>
              <td className={`px-5 py-2.5 text-right tabular-nums ${r.failed ? "text-[#d03b3b]" : "text-[#5c5b57]"}`}>{r.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-5 py-3 text-sm text-[#5c5b57]">Counted over the rings in this matcher&apos;s feed. Green is settled, amber is a lost race (another ring settled the same legs first), red is failed.</p>
    </div>
  );
}

// ---------- page ----------

function Fact({ value, label, detail }: { value: ReactNode; label: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="font-pixel text-3xl leading-none text-[#f0efec] sm:text-4xl">{value}</span>
      <span className="text-sm text-[#c3c2b7]">{label}</span>
      {detail && <span className="text-sm leading-snug text-[#898781]">{detail}</span>}
    </div>
  );
}

export default function NomadDashboard() {
  const [state, setState] = useState<NomadState | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Ring events");
  const query = useRef("");

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    query.current = p.get("mock") === "1" ? "?mock=1" : "";
    const t = TABS.find((x) => x.toLowerCase().includes((p.get("tab") ?? "").toLowerCase()));
    const tabTimer = p.get("tab") && t ? setTimeout(() => setTab(t), 0) : undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/state${query.current}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as NomadState;
        if (stop) return;
        setState(s);
        setFallback(res.headers.get("x-nomad-fallback"));
        setUpdated(Date.now());
        setErr(null);
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
      clearTimeout(tabTimer);
    };
  }, []);

  const ix = useMemo(() => (state ? tokenIndex(state) : null), [state]);
  const counts = useMemo(() => {
    if (!state) return null;
    const settled = state.rings.filter((r) => r.status === "settled");
    const blocks = settled.map((r) => r.blocksToExec).filter((b): b is number => b != null).sort((a, b) => a - b);
    return {
      settled: settled.length,
      lost: state.rings.filter(isLostRace).length,
      failed: state.rings.filter((r) => r.status === "failed" && !isLostRace(r)).length,
      agents: state.agents.length,
      offers: state.agents.reduce((n, a) => n + a.offers.length, 0),
      medianBlocks: blocks.length ? blocks[Math.floor((blocks.length - 1) / 2)] : null,
    };
  }, [state]);

  const live = state?.meta.source === "live";
  const sourceText = !state
    ? err
      ? `Can't reach the state feed (${err})`
      : "Connecting to the state feed"
    : live
      ? "Live from the matcher"
      : state.meta.source === "recorded"
        ? `Recorded testnet state from ${dateTime(state.meta.recordedAt ?? state.meta.generatedAtMs)}${fallback ? ", the matcher is offline" : ""}`
        : state.meta.source === "sim"
          ? "Simulation feed"
          : "Test fixture";
  const matcher = state?.rings[0]?.matcher;

  return (
    <main className="relative min-h-screen w-full overflow-x-clip bg-[#0d0d0d] text-[#f0efec]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(57,135,229,0.16),transparent_70%)]"
      />
      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pb-16 pt-5 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="group flex items-center gap-2 text-[#f0efec]">
            <ArrowLeft size={18} className="text-[#898781] transition-transform duration-300 group-hover:-translate-x-1" />
            <span className="font-pixel text-3xl leading-none">
              <LogoMark className="mr-[0.2em] inline-block h-[1.1em] w-[1.1em] align-[-0.2em]" />
              NOMAD<span className="text-[var(--accent-color)]">.</span>
            </span>
          </Link>
          <nav className="flex items-center gap-5 text-sm text-[#c3c2b7]">
            <Link href="/" className="transition-colors hover:text-[#f0efec]">
              Home
            </Link>
            <Link href="/v2" className="transition-colors hover:text-[#f0efec]">
              Live rings
            </Link>
          </nav>
        </header>

        <div>
          <h1 className="font-pixel text-4xl leading-none sm:text-6xl">Matcher dashboard</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#898781]">
            <span className="flex items-center gap-2 text-[#c3c2b7]">
              <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-[#0ca30c]" : state ? "bg-[#c3c2b7]" : "bg-[#5c5b57]"}`} />
              {sourceText}
            </span>
            {matcher && <span>· matcher {shortAgent(matcher)}</span>}
            {updated && <span>· updated {clock(updated)}</span>}
            <span>· times in UTC</span>
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease }}
            className="motion-static min-w-0 lg:col-span-2"
          >
            <WorkshopSlot state={state} />
          </motion.div>
          <Panel title="Latest ring events" delay={0.08} right={state ? `${state.rings.length} rings` : undefined}>
            <div className="max-h-[360px] overflow-y-auto lg:h-[471px] lg:max-h-none">
              {state ? <EventStream state={state} limit={30} /> : <p className="px-5 py-10 text-sm text-[#898781]">Loading.</p>}
            </div>
          </Panel>
        </div>

        {counts && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.16, duration: 0.6, ease }}
            className="motion-static grid grid-cols-2 divide-white/10 rounded-2xl border border-white/10 bg-[#111110]/85 sm:grid-cols-3 lg:grid-cols-6 [&>*]:border-white/10 max-lg:[&>*]:border-b lg:divide-x"
          >
            <Fact value={counts.settled} label="Rings settled" />
            <Fact value={counts.lost} label="Lost races" detail="Legs already settled by another ring; nothing moved" />
            <Fact value={counts.failed} label="Failed" detail={counts.failed ? "Not signed or rejected; reasons in Ring events" : undefined} />
            <Fact value={counts.agents} label="Agents" />
            <Fact value={counts.offers} label="Open offers" />
            <Fact value={counts.medianBlocks ?? "none"} label="Median blocks to run" />
          </motion.div>
        )}

        <div>
          <div id="tabs" role="tablist" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`relative shrink-0 rounded-full px-4 py-2 text-sm transition-colors duration-200 ${
                  tab === t ? "text-[#0d0d0d]" : "text-[#c3c2b7] hover:text-[#f0efec]"
                }`}
              >
                {tab === t && (
                  <motion.span layoutId="dash-tab" transition={{ duration: 0.4, ease }} className="absolute inset-0 rounded-full bg-[#f0efec]" />
                )}
                <span className="relative">{t}</span>
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.35, ease }}
              className="motion-static mt-4 overflow-hidden rounded-2xl border border-white/10 bg-[#111110]/85"
            >
              {!state || !ix ? (
                <p className="px-5 py-10 text-sm text-[#898781]">Loading.</p>
              ) : tab === "Ring events" ? (
                <EventStream state={state} />
              ) : tab === "Settled on chain" ? (
                <SettledRings state={state} ix={ix} />
              ) : tab === "Agent balances" ? (
                <Balances state={state} ix={ix} />
              ) : (
                <Reputation state={state} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <p className="text-sm text-[#5c5b57]">
          Rings settle on {state?.meta.verifier ?? "the Verifier"} on NEAR testnet. Every transaction link opens NearBlocks.
        </p>
      </div>
    </main>
  );
}
