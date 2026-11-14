"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Group, Vector3 } from "three"
import type { NomadState } from "@/lib/types"
import fallbackState from "@/lib/live-snapshot.json"
import { Bot, specFor } from "./bot"
import { StationBlock } from "./station"
import { Director, STATIONS, buildBots, extraPlays, settledPlays, type BotDef, type DirectorNow } from "./director"
import { LabelContext, LabelProjector, labelEl, newLabelStore, type LabelStore } from "./labels"

export interface RingWorkshopProps {
  state: NomadState | null
  height?: number
}

/** "overview", "follow" (whoever is acting in the current ring), or a pinned bot id. */
type CameraMode = "overview" | "follow" | string

const OVERVIEW_POS = new Vector3(12, 30, 30)
const OVERVIEW_LOOK = new Vector3(0, 0, -1)
// Chase-cam offset from the bot's position (above + diagonal behind).
const FOLLOW_OFFSET = new Vector3(6, 9, 9)
// POS_RATE < LOOK_RATE: the camera glides into place slightly slower than it turns to track.
const POS_RATE = 2.2
const LOOK_RATE = 3.5

function CameraRig({
  mode,
  director,
  botRefs,
}: {
  mode: CameraMode
  director: Director
  botRefs: React.MutableRefObject<Record<string, Group | null>>
}) {
  const { camera } = useThree()
  const desiredPos = useRef(new Vector3())
  const desiredLook = useRef(new Vector3())
  const smoothedLook = useRef(OVERVIEW_LOOK.clone())

  useFrame((_, delta) => {
    const id = mode === "overview" ? null : mode === "follow" ? director.now.focus : mode
    const g = id ? botRefs.current[id] : null
    if (!g) {
      desiredPos.current.copy(OVERVIEW_POS)
      desiredLook.current.copy(OVERVIEW_LOOK)
    } else {
      const bp = g.position
      // Fixed heights so the bot's hop doesn't shake the camera.
      desiredPos.current.set(bp.x + FOLLOW_OFFSET.x, FOLLOW_OFFSET.y, bp.z + FOLLOW_OFFSET.z)
      desiredLook.current.set(bp.x, 0.6, bp.z)
    }
    const dt = Math.min(delta, 0.1)
    camera.position.lerp(desiredPos.current, 1 - Math.exp(-dt * POS_RATE))
    smoothedLook.current.lerp(desiredLook.current, 1 - Math.exp(-dt * LOOK_RATE))
    camera.lookAt(smoothedLook.current)
  })
  return null
}

export function RingWorkshopScene({ state, height = 520 }: RingWorkshopProps) {
  const effective = state ?? (fallbackState as unknown as NomadState)
  const live = state?.meta.source === "live"
  const plays = useMemo(() => settledPlays(effective), [effective])
  const [director] = useState(() => new Director())
  const bots = useMemo(() => buildBots(effective, [...plays, ...extraPlays()]), [effective, plays])

  useEffect(() => {
    director.setPlays(plays, live)
  }, [director, plays, live])
  useEffect(() => {
    director.setBots(bots)
  }, [director, bots])

  const [cameraMode, setCameraMode] = useState<CameraMode>("overview")
  const botRefs = useRef<Record<string, Group | null>>({})
  const registerBotGroup = useCallback((id: string, group: Group | null) => {
    botRefs.current[id] = group
  }, [])
  const [labels] = useState<LabelStore>(newLabelStore)

  // The DOM overlay (tasks, phase line) refreshes a few times a second; positions update every frame.
  const [overlay, setOverlay] = useState<{ now: DirectorNow; tasks: Record<string, string | null> }>({
    now: director.now,
    tasks: {},
  })
  useEffect(() => {
    const id = setInterval(() => {
      const tasks: Record<string, string | null> = {}
      for (const b of bots) tasks[b.id] = director.peek(b.id)?.task ?? null
      setOverlay({ now: director.now, tasks })
    }, 200)
    return () => clearInterval(id)
  }, [director, bots])

  const now = overlay.now
  const following = cameraMode === "follow" ? now.focus : cameraMode === "overview" ? null : cameraMode
  const followName = following ? bots.find((b) => b.id === following)?.name : null
  const txUrl = now.settled && now.play?.tx ? `${effective.meta.explorerTxUrl}${now.play.tx}` : null

  return (
    <div className="relative w-full overflow-hidden rounded-lg">
      <div style={{ height }} className="relative w-full">
        <Canvas
          dpr={[1, 2]}
          camera={{ position: [12, 30, 30], fov: 26, near: 0.1, far: 1000 }}
          onCreated={({ camera }) => camera.lookAt(OVERVIEW_LOOK)}
          onPointerMissed={() => setCameraMode((m) => (m === "overview" || m === "follow" ? m : "overview"))}
        >
          <LabelContext.Provider value={labels}>
            <CameraRig mode={cameraMode} director={director} botRefs={botRefs} />
            <LabelProjector store={labels} />

            <ambientLight intensity={0.75} color="#eaf1ff" />
            <directionalLight position={[10, 20, 8]} intensity={1.1} color="#cfe0ff" />
            <directionalLight position={[-10, 8, -6]} intensity={0.3} color="#9bb8ff" />

            <mesh position={[0, -0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[80, 80]} />
              <meshLambertMaterial color="#0d1320" />
            </mesh>
            <gridHelper args={[80, 40, "#2c4a72", "#132033"]} position={[0, 0.01, 0]} />

            {STATIONS.map((s) => (
              <StationBlock key={s.id} station={s} />
            ))}

            {bots.map((b) => (
              <Bot
                key={b.id}
                def={b}
                director={director}
                onClick={() => setCameraMode(b.id)}
                onGroupReady={registerBotGroup}
              />
            ))}
          </LabelContext.Provider>
        </Canvas>

        {/* Labels, positioned every frame by LabelProjector */}
        <div className="pointer-events-none absolute inset-0 select-none">
          {STATIONS.map((s) => (
            <div key={s.id} data-align="bottom" ref={labelEl(labels, `station:${s.id}`)} className="absolute left-0 top-0 flex flex-col items-center gap-0.5 whitespace-nowrap" style={{ transform: "translate(-9999px,-9999px)" }}>
              <span className="rounded-sm border border-white/15 bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white">{s.label}</span>
              <span className="text-[10px] text-white/55">{s.subLabel}</span>
            </div>
          ))}
          {bots.map((b) => (
            <BotLabel key={b.id} def={b} store={labels} task={overlay.tasks[b.id] ?? null} />
          ))}
        </div>

        {/* Camera modes */}
        <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-md border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
          {(["overview", "follow"] as const).map((m) => {
            const active = m === "overview" ? cameraMode === "overview" : cameraMode !== "overview"
            return (
              <button
                key={m}
                onClick={() => setCameraMode(m)}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  active ? "bg-[#3987e5]/20 text-[#8dbcf3]" : "text-white/55 hover:text-white"
                }`}
              >
                {m === "overview" ? "Overview" : "Follow"}
              </button>
            )
          })}
        </div>

        <div className="pointer-events-none absolute left-3 top-3 text-xs text-white/60">
          {live ? "Live from the matcher on NEAR testnet" : "Replaying settled rings recorded on NEAR testnet"}
          {followName && <span className="text-white/45"> · following {followName}</span>}
        </div>

        <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-4 text-sm">
          <span className="pointer-events-none text-white/85">{now.phase}</span>
          {txUrl && (
            <a href={txUrl} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-[#8dbcf3] hover:text-white">
              View the transaction
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function BotLabel({ def, store, task }: { def: BotDef; store: LabelStore; task: string | null }) {
  const color = useMemo(() => specFor(def.color).accent, [def.color])
  return (
    <div ref={labelEl(store, `bot:${def.id}`)} className="absolute left-0 top-0 flex flex-col items-center gap-0.5 whitespace-nowrap" style={{ transform: "translate(-9999px,-9999px)" }}>
      <span className="text-[11px] font-semibold" style={{ color }}>
        {def.name}
      </span>
      {task && <span className="rounded-sm border border-white/10 bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80">{task}</span>}
    </div>
  )
}
