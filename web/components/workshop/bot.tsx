"use client"

import { useEffect, useMemo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { Color, Group, Mesh, MeshLambertMaterial } from "three"
import type { BotDef, Director } from "./director"
import { useLabel } from "./labels"

/**
 * Voxel robot characters: boxes only, so flat directional lighting carves
 * tonal difference across faces. Silhouette: feet, waist, chest
 * (+ shoulders + chest panel), neck, helmet (+ visor band), antenna.
 */

interface BotSpec {
  body: string
  bodyDark: string
  head: string
  visorBand: string
  visorEye: string
  accent: string
}

export function specFor(color: string): BotSpec {
  const c = new Color(color)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  const shade = (dl: number, ds = 0) =>
    "#" + new Color().setHSL(hsl.h, Math.min(1, Math.max(0, hsl.s + ds)), Math.min(0.95, Math.max(0.04, hsl.l + dl))).getHexString()
  const dark = hsl.l < 0.25
  return {
    body: color,
    bodyDark: dark ? shade(-0.08) : shade(-0.25),
    head: dark ? shade(0.08) : shade(0.08),
    visorBand: "#0b1018",
    visorEye: dark ? "#e6ebf5" : shade(0.3, -0.1),
    accent: dark ? "#c9d3e6" : shade(0.35, -0.15),
  }
}

const HOP_PERIOD = 0.32
const HOP_HEIGHT = 0.35
const SETTLE_HOPS = 3
const SETTLE_PERIOD = 0.42
const SETTLE_HEIGHT = 0.75
const SPEED = 7
const SCALE = 1.3
const IDLE_DIM = 0.32

export function Bot({
  def,
  director,
  onClick,
  onGroupReady,
}: {
  def: BotDef
  director: Director
  onClick: () => void
  onGroupReady?: (id: string, group: Group | null) => void
}) {
  const groupRef = useRef<Group>(null)
  const ringRef = useRef<Mesh>(null)
  const initializedRef = useRef(false)
  const walkingMixRef = useRef(0)
  const bodyRef = useRef<Group>(null)
  const dimRef = useRef(1)
  const spec = useMemo(() => specFor(def.color), [def.color])
  const anchor = useLabel(`bot:${def.id}`)
  const seed = useMemo(() => [...def.id].reduce((s, ch) => s + ch.charCodeAt(0), 0), [def.id])

  useEffect(() => {
    onGroupReady?.(def.id, groupRef.current)
    return () => onGroupReady?.(def.id, null)
  }, [def.id, onGroupReady])

  useFrame((state, delta) => {
    const g = groupRef.current
    if (!g) return
    const t = state.clock.elapsedTime
    const s = director.get(def.id, t)
    const [tx, tz] = s.target

    if (!initializedRef.current) {
      g.position.set(def.home[0], 0, def.home[1])
      g.rotation.y = Math.atan2(-def.home[0], -def.home[1] + 4)
      initializedRef.current = true
      return
    }

    const dx = tx - g.position.x
    const dz = tz - g.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist > 0.02) {
      const step = Math.min(SPEED * Math.min(delta, 0.1), dist)
      g.position.x += (dx / dist) * step
      g.position.z += (dz / dist) * step
    }
    if (dist > 0.05) g.rotation.y = Math.atan2(dx, dz)

    const walkingTarget = dist > 0.15 ? 1 : 0
    walkingMixRef.current += (walkingTarget - walkingMixRef.current) * Math.min(1, delta * 6.7)
    const mix = walkingMixRef.current

    const hopPhase = (t % HOP_PERIOD) / HOP_PERIOD
    const hopY = Math.sin(hopPhase * Math.PI) * HOP_HEIGHT
    const idleY = Math.max(0, Math.sin(t * 2 + seed) * 0.04)
    let y = idleY * (1 - mix) + hopY * mix

    // Settle: every bot of the ring hops on the same beat.
    if (s.hopAt != null) {
      const st = t - s.hopAt
      if (st >= 0 && st < SETTLE_HOPS * SETTLE_PERIOD) {
        const p = (st % SETTLE_PERIOD) / SETTLE_PERIOD
        y = Math.max(y, Math.sin(p * Math.PI) * SETTLE_HEIGHT)
      }
    }
    g.position.y = y

    if (ringRef.current) ringRef.current.visible = s.inRing && s.task !== null

    // Bots outside the current ring are dimmed; the ring's bots are at full colour.
    const dimTarget = s.inRing ? 1 : IDLE_DIM
    const dim = dimRef.current + (dimTarget - dimRef.current) * Math.min(1, delta * 5)
    if (Math.abs(dim - dimRef.current) > 0.002 || !bodyRef.current?.userData.dimmed) {
      dimRef.current = dim
      bodyRef.current?.traverse((o) => {
        const m = (o as Mesh).material as MeshLambertMaterial | undefined
        if (!m || !("color" in m)) return
        if (!o.userData.base) o.userData.base = m.color.clone()
        m.color.copy(o.userData.base as Color).multiplyScalar(dim)
      })
      if (bodyRef.current) bodyRef.current.userData.dimmed = true
    }
  })

  return (
    <group
      ref={groupRef}
      onPointerOver={(e) => {
        e.stopPropagation()
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        document.body.style.cursor = ""
      }}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {/* Shadow blob */}
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.4, 1.0]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} />
      </mesh>

      {/* Activity ring */}
      <mesh ref={ringRef} visible={false} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.7, 0.9, 24]} />
        <meshBasicMaterial color={spec.accent} transparent opacity={0.85} />
      </mesh>

      <group ref={bodyRef} scale={SCALE}>
      {/* Feet */}
      <mesh position={[-0.12, 0.05, 0]}>
        <boxGeometry args={[0.14, 0.1, 0.16]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>
      <mesh position={[0.12, 0.05, 0]}>
        <boxGeometry args={[0.14, 0.1, 0.16]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>

      {/* Waist */}
      <mesh position={[0, 0.18, 0]}>
        <boxGeometry args={[0.42, 0.14, 0.32]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>

      {/* Chest */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[0.56, 0.5, 0.44]} />
        <meshLambertMaterial color={spec.body} />
      </mesh>

      {/* Shoulders */}
      <mesh position={[-0.34, 0.58, 0]}>
        <boxGeometry args={[0.12, 0.22, 0.32]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>
      <mesh position={[0.34, 0.58, 0]}>
        <boxGeometry args={[0.12, 0.22, 0.32]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>

      {/* Chest panel and light */}
      <mesh position={[0, 0.5, 0.23]}>
        <boxGeometry args={[0.34, 0.28, 0.02]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>
      <mesh position={[0, 0.5, 0.245]}>
        <boxGeometry args={[0.08, 0.08, 0.01]} />
        <meshLambertMaterial color={spec.accent} />
      </mesh>

      {/* Neck */}
      <mesh position={[0, 0.83, 0]}>
        <boxGeometry args={[0.22, 0.1, 0.22]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>

      {/* Helmet */}
      <mesh position={[0, 1.08, 0]}>
        <boxGeometry args={[0.5, 0.4, 0.46]} />
        <meshLambertMaterial color={spec.head} />
      </mesh>

      {/* Visor band and eye */}
      <mesh position={[0, 1.1, 0.24]}>
        <boxGeometry args={[0.44, 0.14, 0.02]} />
        <meshLambertMaterial color={spec.visorBand} />
      </mesh>
      <mesh position={[0, 1.1, 0.25]}>
        <boxGeometry args={[0.28, 0.06, 0.01]} />
        <meshLambertMaterial color={spec.visorEye} />
      </mesh>

      {/* Side sensors */}
      <mesh position={[-0.26, 1.08, 0]}>
        <boxGeometry args={[0.04, 0.16, 0.12]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>
      <mesh position={[0.26, 1.08, 0]}>
        <boxGeometry args={[0.04, 0.16, 0.12]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>

      {/* Antenna */}
      <mesh position={[0, 1.42, 0]}>
        <boxGeometry args={[0.05, 0.24, 0.05]} />
        <meshLambertMaterial color={spec.bodyDark} />
      </mesh>
      <mesh position={[0, 1.6, 0]}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshLambertMaterial color={spec.accent} />
      </mesh>

      </group>

      {/* Nameplate anchor (label drawn in the DOM overlay) */}
      <group ref={anchor} position={[0, -0.2, 0]} />
    </group>
  )
}
