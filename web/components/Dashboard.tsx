"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NomadState } from "@/lib/types";
import { DEMO_MS, demoFrame, failedPairs, pickDemoRing } from "@/lib/demo";
import { STATUS, sym, tokenIndex } from "@/lib/format";
import RingGraph from "./RingGraph";
import RingDetail from "./RingDetail";
import RingsTable from "./RingsTable";
import { RacePanel, SwarmPanel } from "./Charts";

const POLL_MS = 1000;

export default function Dashboard() {
  const [live, setLive] = useState<NomadState | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [demo, setDemo] = useState<{ start: number; snap: NomadState } | null>(null);
  const [now, setNow] = useState(0);
  const [captions, setCaptions] = useState(
    () => typeof window === "undefined" || new URLSearchParams(window.location.search).get("captions") !== "0",
  );
  const [flashUntil, setFlashUntil] = useState(0);
  const seenTx = useRef<Set<string>>(new Set());
  const query = useRef("");
  const autoDemo = useRef(false);

  // Read URL flags once in the browser (?mock=1, ?demo=1, ?captions=0).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    query.current = p.get("mock") === "1" ? "?mock=1" : "";
    autoDemo.current = p.get("demo") === "1";
  }, []);

  // Poll the state API (paused while the demo replays a frozen snapshot).
  useEffect(() => {
    if (demo) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/state${query.current}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as NomadState;
        if (stop) return;
        setLive(s);
        setFallback(res.headers.get("x-nomad-fallback"));
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
    };
  }, [demo]);

  // Clock for the demo timeline and flash timers.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setDemo((d) => (d && t - d.start > DEMO_MS + 3000 ? null : d));
    }, 100);
    return () => clearInterval(id);
  }, []);

  const startDemo = useCallback(() => {
    if (live) {
      setSelected(null);
      setDemo({ start: Date.now(), snap: live });
    }
  }, [live]);

  useEffect(() => {
    if (autoDemo.current && live && !demo) {
      autoDemo.current = false;
      startDemo();
    }
  }, [live, demo, startDemo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "d") {
        if (demo) setDemo(null);
        else startDemo();
      }
      if (e.key === "Escape") setDemo(null);
      if (e.key === "c") setCaptions((c) => !c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [demo, startDemo]);

  const state = demo?.snap ?? live;
  const ix = useMemo(() => (state ? tokenIndex(state) : null), [state]);

  const demoBase = useMemo(() => (demo ? pickDemoRing(demo.snap) : null), [demo]);
  const demoPairs = useMemo(() => {
    if (!demo) return [];
    const tix = tokenIndex(demo.snap);
    const ringAgents = new Set(demoBase?.legs.map((l) => l.agent));
    // Try the ring's own agents first: they are the ones who can't trade in pairs.
    const all = failedPairs(demo.snap.agents, (id) => sym(tix, id));
    return [...all.filter((p) => ringAgents.has(p.from)), ...all.filter((p) => !ringAgents.has(p.from))];
  }, [demo, demoBase]);

  const elapsed = demo ? now - demo.start : 0;

  const frame = demo && state ? demoFrame(state, demoBase, demoPairs, Math.max(0, elapsed)) : null;

  // Live mode: focus the pinned ring, else the newest one.
  const liveRing = state && !demo ? (state.rings.find((r) => r.ringId === selected) ?? state.rings[0] ?? null) : null;
  // Flash when a settlement appears that we haven't seen (not for rings already settled at load).
  const seeded = useRef(false);
  useEffect(() => {
    if (!live) return;
    let fresh = false;
    for (const r of live.rings) {
      if (r.status === "settled" && r.txHash && !seenTx.current.has(r.txHash)) {
        seenTx.current.add(r.txHash);
        fresh = true;
      }
    }
    if (fresh && seeded.current) setFlashUntil(Date.now() + 8000);
    seeded.current = true;
  }, [live]);

  if (!state || !ix) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-[#898781]">
        {err ? `Can't reach /api/state: ${err}` : "Loading swarm state…"}
      </div>
    );
  }

  const ring = frame ? frame.ring : liveRing;
  const liveFlash = !demo && now < flashUntil;
  const flash = frame ? frame.settledFlash : liveFlash;
  const showDeltas = frame ? ["settle", "savings", "outro"].includes(frame.phase) : liveFlash;
  const isMock = state.meta.source === "mock";
  const isSim = state.meta.source === "sim";
  const isRecorded = state.meta.source === "recorded";

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-5 py-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#f0efec]">
            Nomad <span className="font-normal text-[#898781]">· agents trade in rings, settled in one NEAR Intents call</span>
          </h1>
          <p className="mt-1 text-xs text-[#898781]">
            Verifier <span className="font-mono text-[#c3c2b7]">{state.meta.verifier}</span>
            {state.meta.verifierShard != null && <> · shard {state.meta.verifierShard}</>} · board{" "}
            <span className="font-mono text-[#c3c2b7]">{state.meta.board}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-[#fab219]/40 px-2.5 py-1 font-medium uppercase tracking-wide text-[#fab219]">NEAR testnet</span>
          {isSim ? (
            <span className="rounded-full border border-[#86b6ef]/50 bg-[#86b6ef]/10 px-2.5 py-1 font-medium uppercase tracking-wide text-[#86b6ef]" title="make sim-serve: simulated swarm, no chain">
              Simulation
            </span>
          ) : isRecorded ? (
            <span
              className="rounded-full border border-[#86b6ef]/50 bg-[#86b6ef]/10 px-2.5 py-1 font-medium uppercase tracking-wide text-[#86b6ef]"
              title="Real testnet state captured from a live run; tx links are real"
            >
              Recorded testnet data{state.meta.recordedAt ? ` · ${new Date(state.meta.recordedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}
            </span>
          ) : isMock ? (
            <span
              className="rounded-full border border-[#ec835a]/50 bg-[#ec835a]/10 px-2.5 py-1 font-medium uppercase tracking-wide text-[#ec835a]"
              title={fallback ?? "No matcher configured; showing the UI fixture"}
            >
              ⚠ Mock data{fallback ? " (matcher offline)" : ""}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full border border-[#0ca30c]/50 px-2.5 py-1 font-medium uppercase tracking-wide text-[#0ca30c]">
              <span className="nomad-dot h-1.5 w-1.5 rounded-full bg-[#0ca30c]" /> Live
            </span>
          )}
          {err && <span className="text-[#e66767]">poll error: {err}</span>}
          <button
            onClick={() => (demo ? setDemo(null) : startDemo())}
            className="rounded-full bg-[#f0efec] px-3.5 py-1.5 text-xs font-semibold text-[#0d0d0d] hover:bg-white"
            title="Keyboard: d to start/stop, c to toggle captions"
          >
            {demo ? `■ Stop demo ${Math.min(60, Math.floor(elapsed / 1000))}s` : "▶ Play 60s demo"}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="relative rounded-xl border border-white/10 bg-[#141413] p-2">
          <RingGraph state={state} ix={ix} ring={ring} pair={frame?.pair ?? null} flash={flash} showDeltas={showDeltas} dimOthers={!!ring && (!!frame || ring.status !== "settled" || liveFlash)} />
          <div className="pointer-events-none absolute left-4 top-3 flex flex-wrap gap-3 text-[11px] text-[#898781]">
            {state.meta.tokens.map((t) => (
              <span key={t.id} className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: ix.get(t.id)?.color }} />
                {t.symbol}
              </span>
            ))}
          </div>
          {frame && captions && frame.caption && (
            <div key={frame.phase} className="nomad-fade-in pointer-events-none absolute inset-x-6 bottom-6 rounded-lg bg-[#0d0d0d]/85 px-5 py-3 text-center text-lg font-medium text-[#f0efec] backdrop-blur">
              {frame.caption}
            </div>
          )}
          {demo && (
            <div className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-xl bg-white/5">
              <div className="h-full bg-[#f0efec]/50" style={{ width: `${Math.min(100, (elapsed / DEMO_MS) * 100)}%` }} />
            </div>
          )}
        </div>
        <RingDetail state={state} ix={ix} ring={ring} highlightSavings={frame?.phase === "savings"} />
      </div>

      <RingsTable state={state} ix={ix} selected={selected} onSelect={setSelected} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SwarmPanel swarm={state.swarm} />
        <RacePanel race={state.race} />
      </div>

      <footer className="flex flex-wrap justify-between gap-2 pb-4 text-[11px] text-[#5c5b57]">
        <span>
          Every agent signs only its own leg. One <code className="font-mono">execute_intents</code> settles the ring, or nothing moves. No wallet needed to watch.
        </span>
        <span>
          <span style={{ color: STATUS.good }}>●</span> signed/settled · <span style={{ color: STATUS.critical }}>●</span> failed · updated{" "}
          {new Date(state.meta.generatedAtMs).toISOString().slice(11, 19)} UTC
        </span>
      </footer>
    </div>
  );
}
