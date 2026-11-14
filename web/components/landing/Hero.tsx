"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import SweepButton from "./SweepButton";

const ease = [0.22, 1, 0.36, 1] as const;

/** Talos's hero motion (blur + scale + rise, staggered; the divider draws in), with Nomad's words. */
export default function Hero() {
  // Same initial state on server and client (no hydration mismatch). Under reduced motion the
  // `motion-static` class (globals.css) pins every element to its final frame instead.
  const from = <T extends object>(v: T) => v;

  const toReplay = (e: React.MouseEvent) => {
    const el = document.getElementById("replay");
    if (!el) return;
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", "#replay");
  };

  return (
    <section className="relative flex min-h-[100svh] w-full flex-col items-center justify-center px-5 pb-16 pt-24 sm:px-8">
      <div className="flex max-w-3xl flex-col items-center gap-5 text-center">
        {/* inline-flex column: the divider takes exactly the wordmark's width */}
        <div className="inline-flex flex-col items-stretch gap-5">
          <motion.h1
            initial={from({ opacity: 0, y: 80, filter: "blur(16px)", scale: 0.9 })}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)", scale: 1 }}
            transition={{ duration: 1, delay: 0.3, ease }}
            className="motion-static font-pixel select-none text-[clamp(4.25rem,10vw,10.5rem)] leading-none tracking-tight text-[#f0efec]"
          >
            NOMAD<span className="text-[var(--accent-color)]">.</span>
          </motion.h1>

          <motion.div
            initial={from({ scaleX: 0 })}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1, delay: 0.9, ease }}
            className="motion-static my-1 w-full origin-left border-t-2 border-[#f0efec]"
          />
        </div>

        <motion.p
          initial={from({ opacity: 0, y: 20, filter: "blur(6px)" })}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.8, delay: 1.05, ease }}
          className="motion-static text-2xl font-medium tracking-tight text-[#f0efec] sm:text-3xl"
        >
          Agents trade in loops.
        </motion.p>

        <motion.p
          initial={from({ opacity: 0, y: 20, filter: "blur(6px)" })}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.8, delay: 1.2, ease }}
          className="motion-static max-w-xl text-base leading-relaxed text-[#c3c2b7] sm:text-lg"
        >
          Any wallet signs its own leg. Anyone can close the loop. One NEAR Intents transaction pays everyone, or no one.
        </motion.p>

        <motion.div
          initial={from({ opacity: 0, y: 16, filter: "blur(6px)" })}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, delay: 1.45, ease }}
          className="motion-static mt-4 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row"
        >
          <SweepButton href="#replay" onClick={toReplay}>
            See a ring settle
          </SweepButton>
          <SweepButton href="/v2?verify=1">Open live rings</SweepButton>
        </motion.div>

        <motion.div
          initial={from({ opacity: 0 })}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 1.7, ease }}
          className="motion-static"
        >
          <Link href="/dashboard" className="text-sm text-[#898781] underline decoration-white/20 underline-offset-4 hover:text-[#c3c2b7] hover:decoration-white/50">
            Matcher dashboard
          </Link>
        </motion.div>
      </div>

      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.0, duration: 0.6 }}
        className="absolute bottom-8 hidden sm:block motion-reduce:!hidden"
      >
        <motion.div
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          className="h-8 w-px bg-gradient-to-b from-[var(--accent-color)]/70 to-transparent"
        />
      </motion.div>
    </section>
  );
}
