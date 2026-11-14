"use client";

// The dashboard's hero: agent3's 3D workshop (RingWorkshop draws its own border and background).

import { RingWorkshop } from "@/components/workshop";
import type { NomadState } from "@/lib/types";

export const WORKSHOP_HEIGHT = 520;

export default function WorkshopSlot({ state }: { state: NomadState | null }) {
  return <RingWorkshop state={state} height={WORKSHOP_HEIGHT} />;
}
