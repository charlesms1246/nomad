"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Group, Mesh, Vector3 } from "three"
import type { NomadState } from "@/lib/types"
import fallbackState from "@/lib/live-snapshot.json"
import { Bot, specFor } from "./bot"
import { StationBlock } from "./station"
import { Director, STATIONS, buildBots, extraPlays, settledPlays, shortName, stationXZ, type BotDef, type DirectorNow } from "./director"
import { LabelContext, LabelProjector, labelEl, newLabelStore, type LabelStore } from "./labels"

export interface RingWorkshopProps {
  state: NomadState | null
  height?: number
}

/** "overview", "follow" (whoever is acting in the current ring), or a pinned bot id. */
type CameraMode = "overview" | "follow" | string

// Landscape: the five stations fill the frame. Portrait (phones): higher and more top-down, pulled back to fit the width.
const OVERVIEW_POS = new Vector3(9, 23.5, 23)
const OVERVIEW_LOOK = new Vector3(0, 0, -1.4)
const PORTRAIT_POS = new Vector3(0, 27, 7)
const PORTRAIT_LOOK = new Vector3(0, 0, -0.6)
// Chase-cam offset from the bot's position (above + diagonal behind).
const FOLLOW_OFFSET = new Vector3(7, 11.5, 11.5)
// POS_RATE < LOOK_RATE: the camera glides into place slightly slower than it turns to track.
const POS_RATE = 2.2
const LOOK_RATE = 3.5

/** Rings contract plays: the execute_intents call leaves the rings contract and travels to the Verifier (a bright cube with a short trail). */
function ExecutePulse({ director }: { director: Director }) {
  const refs = useRef<(Mesh | null)[]>([])
  const [rx, rz] = stationXZ("rings")
  const [vx, vz] = stationXZ("verifier")
  useFrame(() => {
    const p = director.now.pulse
    refs.current.forEach((m, i) => {
      if (!m) return
      const q = p == null ? -1 : p * 1.15 - i * 0.05
      m.visible = q >= 0 && q <= 1
      if (!m.visible) return
      const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2
      m.position.set(rx + (vx - rx) * e, 1.7 + Math.sin(Math.PI * e) * 2.2 - e * 0.4, rz + (vz - rz) * e)
      m.rotation.set(q * 6, q * 8, 0)
    })
  })
  return (
    <group>
      {[0.42, 0.3, 0.22, 0.15].map((size, i) => (
        <mesh key={i} ref={(m) => { refs.current[i] = m }} visible={false}>
          <boxGeometry args={[size, size, size]} />
          <meshBasicMaterial color={i === 0 ? "#cfe3ff" : "#3987e5"} transparent opacity={1 - i * 0.2} />
        </mesh>
      ))}
    </group>
  )
}

function CameraRig({
  mode,
  director,
  botRefs,
}: {
  mode: CameraMode
  director: Director
  botRefs: React.MutableRefObject<Record<string, Group | null>>
}) {
  const { camera, size } = useThree()
  const desiredPos = useRef(new Vector3())
  const desiredLook = useRef(new Vector3())
  const smoothedLook = useRef(OVERVIEW_LOOK.clone())

  useFrame((_, delta) => {
    const id = mode === "overview" ? null : mode === "follow" ? director.now.focus : mode
    const g = id ? botRefs.current[id] : null
    if (!g) {
      const aspect = size.width / Math.max(1, size.height)
      const portrait = aspect < 1
      const pos = portrait ? PORTRAIT_POS : OVERVIEW_POS
      const look = portrait ? PORTRAIT_LOOK : OVERVIEW_LOOK
      // Narrower than the reference aspect sees less across: pull back along the same line to keep every station in.
      const pull = Math.max(1, (portrait ? 1.7 : 1.6) / Math.max(0.3, aspect))
      desiredPos.current.copy(pos).sub(look).multiplyScalar(pull).add(look)
      desiredLook.current.copy(look)
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

  // Under 640 px wide (phones): short wallet names, no station sublabels.
  const boxRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [cameraMode, setCameraMode] = useState<CameraMode>("overview")
  const botRefs = useRef<Record<string, Group | null>>({})
  const registerBotGroup = useCallback((id: string, group: Group | null) => {
    botRefs.current[id] = group
  }, [])
  const [labels] = useState<LabelStore>(newLabelStore)

  // The DOM overlay (tasks, phase line) refreshes a few times a second; positions update every frame.
  const [overlay, setOverlay] = useState<{ now: DirectorNow; members: Record<string, { shown: boolean; raise: boolean }> }>({
    now: director.now,
    members: {},
  })
  useEffect(() => {
    const id = setInterval(() => {
      const members: Record<string, { shown: boolean; raise: boolean }> = {}
      for (const b of bots) {
        const p = director.peek(b.id)
        members[b.id] = { shown: !!p?.inRing, raise: !!p?.raise }
      }
      setOverlay({ now: director.now, members })
    }, 200)
    return () => clearInterval(id)
  }, [director, bots])

  const now = overlay.now
  const following = cameraMode === "follow" ? now.focus : cameraMode === "overview" ? null : cameraMode
  const followName = following ? bots.find((b) => b.id === following)?.name : null
  const txUrl = now.settled && now.play?.tx ? `${effective.meta.explorerTxUrl}${now.play.tx}` : null

  return (
    <div ref={boxRef} className="relative w-full overflow-hidden rounded-lg">
      <div style={{ height }} className="relative w-full">
        <Canvas
          dpr={[1, 2]}
          camera={{ position: [9, 23.5, 23], fov: 26, near: 0.1, far: 1000 }}
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
            <ExecutePulse director={director} />

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
            <div key={s.id} data-align="bottom" ref={labelEl(labels, `station:${s.id}`)} className="absolute left-0 top-0 flex flex-col items-center gap-1 whitespace-nowrap" style={{ transform: "translate(-9999px,-9999px)" }}>
              <span className="rounded-sm border border-white/15 bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white">{s.label}</span>
              {!narrow && <span className="rounded-sm bg-black/55 px-1.5 text-[10px] leading-4 text-white/65">{s.subLabel}</span>}
            </div>
          ))}
          {/* Names only for the bots in the current ring; the bottom line says what is happening */}
          {bots.map((b) => (
            <BotLabel key={b.id} def={b} store={labels} narrow={narrow} shown={!!overlay.members[b.id]?.shown} raise={!!overlay.members[b.id]?.raise} />
          ))}
        </div>

        {/* Status line and camera modes share one row, so the line wraps instead of running under the buttons */}
        <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex items-start justify-between gap-3">
          <div className="min-w-0 pt-1 text-xs leading-snug text-white/60">
            {live ? "Live from the matcher on NEAR testnet" : "Replaying settled rings recorded on NEAR testnet"}
            {followName && <span className="text-white/45"> · following {followName}</span>}
          </div>
          <div className="pointer-events-auto flex shrink-0 gap-1 rounded-md border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
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

function BotLabel({ def, store, shown, raise, narrow }: { def: BotDef; store: LabelStore; shown: boolean; raise: boolean; narrow: boolean }) {
  const color = useMemo(() => specFor(def.color).accent, [def.color])
  const name = narrow ? shortName(def.id, true) : def.name
  // Two placements, under the feet and above the head; alternate ring members use the upper one so neighbours never share a line.
  const tag = (top: boolean) => (
    <div
      key={top ? "top" : "bottom"}
      data-align={top ? "bottom" : undefined}
      ref={labelEl(store, `${top ? "bot-top" : "bot"}:${def.id}`)}
      className="absolute left-0 top-0 whitespace-nowrap"
      style={{ transform: "translate(-9999px,-9999px)" }}
    >
      <span
        className="rounded-sm bg-black/60 px-1 text-[11px] font-semibold transition-opacity duration-200"
        style={{ color, opacity: shown && raise === top ? 1 : 0 }}
      >
        {name}
      </span>
    </div>
  )
  return (
    <>
      {tag(false)}
      {tag(true)}
    </>
  )
}
