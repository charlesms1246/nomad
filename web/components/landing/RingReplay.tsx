"use client";

// Replays one real v2 ring from rings.nomadswarm.testnet, stage by stage. Adapted from Talos's
// decision-lifecycle bento (pending / active / done cells, sweep light, prev / next / pause with
// auto-resume), with plain headings and real chain data. Reads testnet when the section nears the
// viewport; until then, or if RPC fails, it shows a saved copy of the same ring.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import fallback from "@/lib/replay-fallback.json";
import { DEFAULT_REPLAY_RING, loadReplay, type ReplayData } from "@/lib/replay";
import { V2_TOKENS, shortId } from "@/lib/v2";
import { fmtAmtExact, tokenIndexOf } from "@/lib/format";
import { WalletBadge } from "@/components/V2Rings";

const EXPLORER = "https://testnet.nearblocks.io";
const ease = [0.22, 1, 0.36, 1] as const;
const STAGES = ["Proposed", "Legs attached", "Closed by a stranger", "Settled in one transaction", "Tips paid to the closer", "Reputation updated"] as const;
const DURATIONS = [3200, 5200, 3600, 4200, 3200, 4600];
const MANUAL_RESUME_MS = 15_000;
const ACCENT = "#3987e5";
const GOOD = "#0ca30c";

const ix = tokenIndexOf(V2_TOKENS);
const amt = (t: string, a: string) => fmtAmtExact(ix, t, a);
const sym = (t: string) => ix.get(t)?.symbol ?? t;
const n = (h: number) => h.toLocaleString("en-US");

function TxLink({ hash, children }: { hash: string | null | undefined; children: ReactNode }) {
  if (!hash) return null;
  return (
    <a href={`${EXPLORER}/txns/${hash}`} target="_blank" rel="noopener noreferrer" className="text-[#86b6ef] underline decoration-[#86b6ef]/30 underline-offset-2 hover:decoration-[#86b6ef]">
      {children} ↗
    </a>
  );
}

function Acct({ id }: { id: string }) {
  return (
    <a href={`${EXPLORER}/address/${id}`} target="_blank" rel="noopener noreferrer" title={id} className="hover:underline">
      {shortId(id)}
    </a>
  );
}

function Cell({ i, stage, span = 1, children }: { i: number; stage: number; span?: 1 | 2 | 3; children: ReactNode }) {
  const active = stage === i;
  const done = stage > i;
  const spanCls = span === 3 ? "md:col-span-3" : span === 2 ? "md:col-span-2" : "";
  return (
    <motion.div
      animate={{ opacity: active || done ? 1 : 0.35 }}
      transition={{ duration: 0.4, ease }}
      className={`${spanCls} relative flex ${span === 3 ? "" : "min-h-[200px]"} flex-col overflow-hidden bg-[#111110] p-5 transition-shadow duration-500`}
      style={{
        boxShadow: active
          ? `inset 3px 0 0 ${ACCENT}, 0 0 28px ${ACCENT}22, inset 0 0 80px ${ACCENT}10`
          : done
            ? `inset 3px 0 0 ${ACCENT}99`
            : `inset 2px 0 0 ${ACCENT}33`,
      }}
    >
      {active && (
        <motion.div
          aria-hidden
          initial={{ x: "-100%" }}
          animate={{ x: "300%" }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
          className="pointer-events-none absolute left-0 top-0 h-px w-1/3 motion-reduce:hidden"
          style={{ background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)` }}
        />
      )}
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-white/5 pb-2">
        <h3 className={`text-sm font-medium ${active ? "text-[#f0efec]" : done ? "text-[#c3c2b7]" : "text-[#5c5b57]"}`}>{STAGES[i]}</h3>
        {done && <Check size={14} strokeWidth={2.5} style={{ color: ACCENT }} aria-label="done" />}
      </div>
      <div className="flex flex-1 flex-col gap-2 text-sm text-[#c3c2b7]">{children}</div>
    </motion.div>
  );
}

/** Animates children in one by one when their stage becomes active; otherwise just shows them
 * (pending cells are already dimmed by <Cell>). Remounts on activation so the reveal replays. */
function Stagger({ i, stage, index, children }: { i: number; stage: number; index: number; children: ReactNode }) {
  const active = stage === i;
  return (
    <motion.div
      key={active ? "active" : "idle"}
      initial={active ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: active ? 0.35 + index * 0.9 : 0, ease }}
      className="motion-static"
    >
      {children}
    </motion.div>
  );
}

export default function RingReplay() {
  const [data, setData] = useState<ReplayData>(fallback as unknown as ReplayData);
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState(0);
  const [paused, setPaused] = useState(false);
  const [manualLeft, setManualLeft] = useState(0); // seconds until auto-play resumes after a manual step
  const [reduced, setReduced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reduced motion: every stage shown, nothing auto-advances (prev / next still work).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const t = setTimeout(() => {
      if (mq.matches) {
        setReduced(true);
        setStage(STAGES.length);
        setPaused(true);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Load live data when the section is near the viewport (keeps it off the critical path).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ringId = new URLSearchParams(window.location.search).get("ring") ?? DEFAULT_REPLAY_RING;
    let started = false;
    const io = new IntersectionObserver(
      (es) => {
        if (started || !es.some((e) => e.isIntersecting)) return;
        started = true;
        io.disconnect();
        const saved = fallback as unknown as ReplayData;
        loadReplay(ringId, saved).then(
          (d) => {
            // Same ring: anything the live read couldn't get stays as in the saved copy (real data).
            if (d.ring.id === saved.ring.id) {
              d = {
                ...d,
                proposeTx: d.proposeTx ?? saved.proposeTx,
                attach: d.attach.map((a, j) => a ?? saved.attach[j] ?? null),
                close: d.close ?? saved.close,
                tipsPaid: Object.keys(d.tipsPaid).length ? d.tipsPaid : saved.tipsPaid,
              };
            }
            setData(d);
          },
          () => setFailed(true),
        );
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const manual = manualLeft > 0;

  // Auto-advance (loops); paused, manual stepping and reduced motion stop it.
  useEffect(() => {
    if (paused || reduced) return;
    if (manual) {
      const t = setTimeout(() => setManualLeft((x) => Math.max(0, x - 1)), 1000);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStage((s) => (s + 1) % STAGES.length), DURATIONS[Math.min(stage, STAGES.length - 1)]);
    return () => clearTimeout(t);
  }, [stage, paused, manual, manualLeft, reduced]);

  const step = (d: 1 | -1) => {
    setManualLeft(MANUAL_RESUME_MS / 1000);
    setStage((s) => (Math.min(s, STAGES.length - 1) + d + STAGES.length) % STAGES.length);
  };

  const { ring, close } = data;
  const k = ring.legs.length;
  const loop = [...ring.legs.map((l) => sym(l.give)), sym(ring.legs[0].give)].join(" → ");
  const stds = close?.signedStandards ?? ring.standards;
  const nStd = new Set(stds.filter(Boolean)).size;
  const blocks = close?.executedHeight != null ? close.executedHeight - close.includedHeight : null;
  const resumeIn = manualLeft;
  const people = [...ring.legs.map((l) => l.agent), ...(ring.closer ? [ring.closer] : [])];

  return (
    <div ref={rootRef} className="overflow-hidden rounded-2xl border border-white/10 bg-[#0d0d0d]/85">
      <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-[#f0efec]">
            Ring <span className="font-mono">{ring.id.slice(0, 8)}</span>, {k} wallets, {new Date(ring.created_ms).toISOString().slice(0, 16).replace("T", " ")} UTC
          </p>
          <p className="text-xs text-[#898781]">
            {data.source === "live"
              ? "Read from testnet by your browser just now."
              : failed
                ? "Testnet didn’t answer, so this is a saved copy of the same ring. Every link still opens the real transaction."
                : "Showing a saved copy while testnet loads."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => step(-1)} aria-label="Previous step" className="rounded-full border border-white/15 p-1.5 text-[#c3c2b7] hover:border-white/40 hover:text-[#f0efec]">
            <ChevronLeft size={14} />
          </button>
          <div className="flex items-center gap-1" aria-hidden>
            {STAGES.map((_, i) => (
              <span key={i} className="h-1 w-4 rounded-full transition-colors duration-300" style={{ background: i < stage ? "#c3c2b7" : i === stage ? ACCENT : "#383835" }} />
            ))}
          </div>
          <button type="button" onClick={() => step(1)} aria-label="Next step" className="rounded-full border border-white/15 p-1.5 text-[#c3c2b7] hover:border-white/40 hover:text-[#f0efec]">
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setManualLeft(0);
              setPaused((p) => !p);
              if (stage >= STAGES.length) setStage(0);
            }}
            className="ml-1 flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-xs text-[#c3c2b7] hover:border-white/40 hover:text-[#f0efec]"
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? "Play" : manual ? `Paused, resumes in ${resumeIn}s` : "Pause"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-px bg-white/10 md:grid-cols-3">
        <Cell i={0} stage={stage}>
          <p>
            By <span className="text-[#f0efec]"><Acct id={ring.proposer} /></span>. Any account can propose a ring.
          </p>
          <p className="text-[#f0efec]">{k} legs in one loop</p>
          <p>{loop}</p>
          <p className="mt-auto text-xs">
            <TxLink hash={data.proposeTx}>Proposal transaction</TxLink>
          </p>
        </Cell>

        <Cell i={1} stage={stage} span={2}>
          <p className="text-xs text-[#898781]">Each wallet signs only its own leg, in its own format.</p>
          <div className="flex flex-col gap-2.5">
            {ring.legs.map((l, j) => (
              <Stagger key={j} i={1} stage={stage} index={j}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-28 shrink-0 text-[#f0efec]">
                    <Acct id={l.agent} />
                  </span>
                  <WalletBadge standard={stds[j] ?? null} agent={l.agent} />
                  <span className="tabular-nums">
                    gives {amt(l.give, l.give_amt)}, gets {amt(l.get, l.get_amt)}
                  </span>
                  <span className="text-xs">
                    <TxLink hash={data.attach[j]?.tx}>
                      {data.attach[j] && data.attach[j]!.relayedBy !== l.agent ? `relayed by ${shortId(data.attach[j]!.relayedBy)}` : "attached"}
                    </TxLink>
                  </span>
                </div>
              </Stagger>
            ))}
          </div>
        </Cell>

        <Cell i={2} stage={stage}>
          {ring.closer ? (
            <>
              <p className="text-2xl font-medium text-[#f0efec]">
                <Acct id={ring.closer} />
              </p>
              <p>{close?.stranger ?? !ring.legs.some((l) => l.agent === ring.closer) ? `Not one of the ${k} agents. Anyone can close a fully signed ring and earn its tips.` : "One of the ring’s own agents closed it."}</p>
              <p className="mt-auto text-xs">
                <TxLink hash={close?.tx}>Close transaction</TxLink>
              </p>
            </>
          ) : (
            <p>Not closed yet.</p>
          )}
        </Cell>

        <Cell i={3} stage={stage}>
          {close ? (
            <>
              <p className="text-[#f0efec]">
                {close.success ? `${k} legs settled by one execute_intents` : "The settlement failed, so nothing moved"}
              </p>
              <p>
                Close in block {n(close.includedHeight)}
                {close.executedHeight != null && (
                  <>
                    , execute_intents in block {n(close.executedHeight)}
                    {blocks != null ? ` (${blocks} later: the contract calls the Verifier)` : ""}
                  </>
                )}
                .
              </p>
              <p>
                {nStd} wallet standard{nStd === 1 ? "" : "s"} in one batch. Every leg settled, or none would have.
              </p>
              <p className="mt-auto text-xs" style={{ color: close.allMatch ? GOOD : "#e66767" }}>
                {close.allMatch ? "✓ Each leg matches what the Verifier executed." : "✗ The chain does not match this ring."}
              </p>
            </>
          ) : (
            <p>Not settled yet.</p>
          )}
        </Cell>

        <Cell i={4} stage={stage}>
          {Object.keys(data.tipsPaid).length ? (
            <>
              <p>
                To <span className="text-[#f0efec]">{ring.closer ? <Acct id={ring.closer} /> : "the closer"}</span>, from the ring contract:
              </p>
              {Object.entries(data.tipsPaid).map(([t, a], j) => (
                <Stagger key={t} i={4} stage={stage} index={j}>
                  <p className="tabular-nums text-[#f0efec]">+{amt(t, a)}</p>
                </Stagger>
              ))}
              <p className="mt-auto text-xs text-[#898781]">Each leg signed its own tip into the batch.</p>
            </>
          ) : (
            <p>No tips paid.</p>
          )}
        </Cell>

        <Cell i={5} stage={stage} span={3}>
          <p className="text-xs text-[#898781]">The ring contract records every outcome. Totals as of now:</p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            {people.map((a, j) => {
              const r = data.reputation[a];
              if (!r) return null;
              const isCloser = a === ring.closer;
              return (
                <Stagger key={a} i={5} stage={stage} index={j}>
                  <div className="flex items-baseline justify-between gap-3 rounded-lg bg-white/[.03] px-3 py-2">
                    <span className="text-[#f0efec]">
                      <Acct id={a} />
                    </span>
                    <span className="tabular-nums">{isCloser ? `${r.rings_closed} rings closed` : `${r.rings_settled} ring${r.rings_settled === 1 ? "" : "s"} settled`}</span>
                  </div>
                </Stagger>
              );
            })}
          </div>
        </Cell>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-5 py-3 text-xs text-[#898781]">
        <span>Every link opens the real testnet transaction.</span>
        <a href={`/v2?verify=1#${ring.id}`} className="text-[#86b6ef] hover:underline">
          Check this ring yourself →
        </a>
      </div>
    </div>
  );
}
