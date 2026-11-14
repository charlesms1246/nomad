"use client";

// The dashboard's hero: agent3's 3D workshop (RingWorkshop, own border, 520 px tall).
// Until that component lands, an empty frame of the same size holds its place (no layout shift).

import type { NomadState } from "@/lib/types";

export const WORKSHOP_HEIGHT = 520;

export default function WorkshopSlot({ state }: { state: NomadState | null }) {
  return (
    <div
      style={{ height: WORKSHOP_HEIGHT }}
      className="flex w-full items-center justify-center rounded-2xl border border-white/10 bg-[radial-gradient(50%_50%_at_50%_50%,rgba(57,135,229,0.12),transparent_70%)]"
    >
      <p className="text-sm text-[#5c5b57]">{state ? "The workshop is loading" : "Loading"}</p>
    </div>
  );
}
