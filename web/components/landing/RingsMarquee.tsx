"use client";

// Recent rings from rings.nomadswarm.testnet as a scroll-velocity marquee (Talos's loop: it drifts on
// its own, scrolling adds velocity, hovering slows it nearly to a stop). Each item links to /v2.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { shortId, type V2Ring } from "@/lib/v2";
import { useLandingChain, walletMix } from "@/lib/landing";

const WALLET_DOT: Record<string, string> = { NEAR: "#3987e5", "Ethereum wallet": "#d95926", "Solana-style": "#9085e9", "ed25519 key": "#9085e9" };

function statusOf(r: V2Ring, now: number): { label: string; color: string } {
  if (r.status === "Settled") return { label: "Settled", color: "#0ca30c" };
  if (r.status === "Failed") return { label: "Close failed", color: "#d03b3b" };
  if (r.status === "Closing") return { label: "Closing", color: "#fab219" };
  return r.deadline_ms < now ? { label: "Expired", color: "#5c5b57" } : { label: "Open", color: "#c3c2b7" };
}

function Item({ r, now }: { r: V2Ring; now: number }) {
  const s = statusOf(r, now);
  const mix = walletMix(r);
  return (
    <Link
      href={`/v2#${r.id}`}
      className="mx-2 flex shrink-0 items-center gap-3 whitespace-nowrap rounded-full border border-white/10 bg-[#111110]/90 px-5 py-2.5 text-sm text-[#c3c2b7] transition-colors duration-200 hover:border-[var(--accent-color)] hover:text-[#f0efec]"
      title={`${r.legs.map((l) => shortId(l.agent)).join(", ")}${r.closer ? `; closed by ${shortId(r.closer)}` : ""}`}
    >
      <span className="flex items-center gap-1.5 text-[#f0efec]">
        <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
        {s.label}
      </span>
      <span>
        {r.legs.length} wallets
      </span>
      <span className="flex items-center gap-2">
        {mix.map((m) => (
          <span key={m} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: WALLET_DOT[m] ?? "#898781" }} />
            {m}
          </span>
        ))}
      </span>
    </Link>
  );
}

export default function RingsMarquee() {
  const chain = useLandingChain();
  const trackRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  // For "expired" labels. Read after mount: the page is prerendered, so no clock reads in render.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(t);
  }, []);
  const ready = chain && chain !== "error" && chain.rings.length > 0;

  useEffect(() => {
    if (!ready || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let pos = 0;
    let lastY = window.scrollY;
    let velocity = 0;
    let speed = 1;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - last, 64) / 16.67;
      last = now;
      const y = window.scrollY;
      velocity = velocity * 0.92 + (y - lastY) * 0.08;
      lastY = y;
      speed += ((hoverRef.current ? 0.12 : 1) - speed) * 0.08;
      pos += (0.8 + velocity * 0.45) * speed * dt;
      const el = trackRef.current;
      if (el) {
        const half = el.scrollWidth / 2;
        if (half > 0) el.style.transform = `translate3d(${-((((pos % half) + half) % half))}px, 0, 0)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  if (chain === "error") return null; // no made-up rings: omit when testnet can't be read
  // Reserve the band's height while loading (no layout shift).
  if (!ready) return <div className="h-[60px]" aria-hidden />;

  // Fill at least ~two screen widths per half so the loop never shows a gap.
  const reps = Math.max(2, Math.ceil(12 / chain.rings.length));
  const half = Array.from({ length: reps }, () => chain.rings).flat();

  return (
    <div
      className="overflow-hidden py-2 [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)] motion-reduce:overflow-x-auto"
      onMouseEnter={() => (hoverRef.current = true)}
      onMouseLeave={() => (hoverRef.current = false)}
      aria-label="Recent rings on testnet"
    >
      <div ref={trackRef} className="flex w-max items-center will-change-transform">
        {[...half, ...half].map((r, i) => (
          <Item key={`${r.id}-${i}`} r={r} now={now} />
        ))}
      </div>
    </div>
  );
}
