"use client";

// Three facts read from rings.nomadswarm.testnet. Nothing here is typed in by hand: if testnet
// can't be read, the section is left out.

import { factsOf, useLandingChain } from "@/lib/landing";

function Fact({ value, title, detail }: { value: string; title: string; detail: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-[#0d0d0d]/80 p-6">
      <p className="font-pixel text-5xl leading-none text-[#f0efec] sm:text-6xl">{value}</p>
      <p className="text-base font-medium text-[#f0efec]">{title}</p>
      <p className="text-sm leading-relaxed text-[#898781]">{detail}</p>
    </div>
  );
}

export default function ChainFacts() {
  const chain = useLandingChain();
  if (chain === "error") return null;
  if (!chain) return <div className="min-h-[220px]" aria-hidden />; // reserve space, no layout shift
  const f = factsOf(chain);
  return (
    <section className="mx-auto w-full max-w-6xl px-5 sm:px-8">
      <h2 className="font-pixel mb-6 text-3xl text-[#f0efec] sm:text-4xl">On testnet now</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Fact value={String(f.settled)} title="Rings settled" detail={`Out of ${f.proposed} proposed on the ring contract. Each settled ring paid every leg in a single execute_intents.`} />
        {f.standards.length > 0 && (
          <Fact
            value={String(f.standards.length)}
            title="Wallet types"
            detail={`Seen in settled rings: ${f.standards.join(", ")}. Each leg is signed in its own wallet's format.`}
          />
        )}
        {f.settledLoaded > 0 && (
          <Fact
            value={`${f.closedByStranger}/${f.settledLoaded}`}
            title="Closed by anyone"
            detail="Settled rings closed by an account that was not one of the ring's agents. The closer earns the tips."
          />
        )}
      </div>
    </section>
  );
}
