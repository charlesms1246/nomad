"use client"

// <RingWorkshop state={NomadState | null} height?={number} />: the voxel workshop where the agents
// post offers, attach legs, and a closer settles each ring in one execute_intents call.
// three.js only runs in the browser, so the scene loads with ssr: false.

import dynamic from "next/dynamic"
import type { RingWorkshopProps } from "./scene"

const Scene = dynamic(() => import("./scene").then((m) => m.RingWorkshopScene), {
  ssr: false,
  loading: () => null,
})

export function RingWorkshop({ state, height = 520 }: RingWorkshopProps) {
  return (
    <div style={{ minHeight: height }} className="w-full overflow-hidden rounded-lg border border-white/10 bg-[#0a0f18]">
      <Scene state={state} height={height} />
    </div>
  )
}

export type { RingWorkshopProps }
export default RingWorkshop
