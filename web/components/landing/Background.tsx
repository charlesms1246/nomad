"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// The shader is not on the critical path: it loads after hydration, client only.
const Dither = dynamic(() => import("./Dither"), { ssr: false });

// Wave colour: the accent blue (#3987e5), darkened so the dither stays a background.
const WAVE: [number, number, number] = [0.16, 0.36, 0.62];

/**
 * Fixed, full-viewport background. A static CSS ring sits underneath, so there is something
 * on screen before WebGL starts, with reduced motion, or if WebGL is unavailable.
 */
export default function Background() {
  const [motionOk, setMotionOk] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionOk(!mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 bg-[#0d0d0d]">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 50%, transparent 0, transparent min(27vh, 32vw), rgba(57,135,229,0.16) min(34vh, 40vw), transparent min(41vh, 48vw))",
        }}
      />
      {motionOk !== null && (
        <div className="absolute inset-0">
          <Dither
            waveColor={WAVE}
            disableAnimation={!motionOk}
            enableMouseInteraction={false}
            colorNum={4}
            pixelSize={2}
            waveAmplitude={0.35}
            waveFrequency={8}
            waveSpeed={0.04}
            pixelRatio={0.4}
            ringMix={1}
          />
        </div>
      )}
      <div className="absolute inset-0 bg-[#0d0d0d]/45" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-b from-transparent to-[#0d0d0d]/70" />
    </div>
  );
}
