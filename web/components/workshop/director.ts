// What the workshop shows: which bots exist, where the stations stand, and the choreography of a
// ring's life (offers on the board, legs attached, a closer closes, one execute_intents settles it).
// Everything is a pure function of time, so the scene never drifts out of step: the director
// plays one ring at a time, rings newly settled in a live state first, otherwise the recorded
// settled rings on a loop.

import type { NomadState, Ring } from "@/lib/types"
import replayFallback from "@/lib/replay-fallback.json"

export type StationId = "board" | "rings" | "verifier" | "mandate" | "reputation"
export type MeshId = "compute" | "storage" | "dispatch" | "vault" | "shrine"

export interface Station {
  id: StationId
  meshId: MeshId
  label: string
  subLabel: string
  position: [number, number] // [x, z]
}

export const stationXZ = (id: StationId) => STATIONS.find((s) => s.id === id)!.position

export const STATIONS: Station[] = [
  { id: "board", meshId: "dispatch", label: "Offer board", subLabel: "board.nomadswarm.testnet", position: [-7, -5] },
  { id: "rings", meshId: "compute", label: "Rings contract", subLabel: "propose and attach", position: [7, -5] },
  { id: "verifier", meshId: "vault", label: "Verifier", subLabel: "execute_intents", position: [0, -7.5] },
  { id: "mandate", meshId: "shrine", label: "Mandate", subLabel: "Chain Signatures", position: [-7, 4.5] },
  { id: "reputation", meshId: "storage", label: "Reputation", subLabel: "on the rings contract", position: [7, 4.5] },
]

const stationPos = (id: StationId) => STATIONS.find((s) => s.id === id)!.position

export interface BotDef {
  id: string // full account id
  name: string // what the nameplate says
  kind: "agent" | "closer"
  color: string
  home: [number, number]
}

const NAMED: Record<string, string> = {
  a01: "#c98500",
  a02: "#d95926",
  a03: "#3987e5",
  a04: "#199e70",
  a05: "#d55181",
  a06: "#0ca30c",
  a07: "#9085e9",
  a08: "#e66767",
  a09: "#4fb3bf",
  a10: "#b08d57",
  a11: "#7a8cff",
  a12: "#c45ab3",
  k4: "#2b3140",
  "intents-matcher-1": "#8a94a6",
}
const EXTRA = ["#627eea", "#14b890", "#e0a458", "#a3b18a", "#d4776b", "#6c9bd2"]

/** "a01.nomadswarm.testnet" -> "a01"; "0x810d…f371"; 64-hex -> "0453…66c2". */
export function shortName(account: string, tiny = false): string {
  const a = account.replace(/\s*\(.*\)$/, "")
  if (/^0x[0-9a-f]{40}$/i.test(a)) return tiny ? `${a.slice(0, 4)}…${a.slice(-2)}` : `${a.slice(0, 6)}…${a.slice(-4)}`
  if (/^[0-9a-f]{64}$/i.test(a)) return tiny ? `${a.slice(0, 4)}…${a.slice(-2)}` : `${a.slice(0, 4)}…${a.slice(-4)}`
  return a.replace(/\.nomadswarm\.testnet$/, "")
}

const cleanAccount = (a: string) => a.replace(/\s*\(.*\)$/, "")
/** Ethereum-style wallets sign through the mandate contract (Chain Signatures). */
const viaMandate = (a: string) => /^0x[0-9a-f]{40}$/i.test(a)

/** One ring as the workshop plays it. */
export interface Play {
  id: string
  legs: string[] // agent accounts, in ring order
  closer: string
  tx: string | null
  version: "v1" | "v2"
}

function playFromRing(r: Ring): Play {
  return {
    id: r.ringId,
    legs: r.legs.map((l) => l.agent),
    closer: cleanAccount(r.matcher),
    tx: r.txHash,
    version: "v1",
  }
}

const V2_PLAY: Play | null = (() => {
  const d = replayFallback as unknown as {
    ring?: { id: string; legs: { agent: string }[]; closer?: string; status?: string }
    close?: { tx: string; closer: string; success: boolean } | null
  }
  if (!d.ring || !d.close?.success) return null
  return { id: d.ring.id, legs: d.ring.legs.map((l) => l.agent), closer: d.close.closer, tx: d.close.tx, version: "v2" }
})()

/** Plays the director adds on its own (the recorded v2 ring), so their bots get built too. */
export const extraPlays = (): Play[] => (V2_PLAY ? [V2_PLAY] : [])

/** Settled rings in the state, oldest first, one per ring id. */
export function settledPlays(state: NomadState | null): Play[] {
  if (!state) return []
  const seen = new Set<string>()
  const out: Play[] = []
  for (const r of [...state.rings].sort((a, b) => a.proposedAtMs - b.proposedAtMs)) {
    if (r.status !== "settled" || seen.has(r.ringId)) continue
    seen.add(r.ringId)
    out.push(playFromRing(r))
  }
  return out
}

export function buildBots(state: NomadState | null, plays: Play[]): BotDef[] {
  const agents: string[] = []
  const closers: string[] = []
  const add = (list: string[], a: string) => {
    if (!agents.includes(a) && !closers.includes(a)) list.push(a)
  }
  for (const a of state?.agents ?? []) add(agents, a.id)
  for (const p of plays) for (const l of p.legs) add(agents, l)
  for (const p of plays) add(closers, p.closer)
  // closers first so a closer that also trades stays a closer
  const bots: BotDef[] = []
  let extra = 0
  const color = (a: string) => NAMED[shortName(a)] ?? EXTRA[extra++ % EXTRA.length]
  // Idle bots wait in neat rows between the front stations, away from the docks.
  const all = [...agents.map((a) => [a, "agent"] as const), ...closers.map((a) => [a, "closer"] as const)]
  const perRow = Math.max(6, Math.ceil(all.length / 2))
  const gap = Math.min(1.15, 8.6 / Math.max(1, perRow - 1))
  all.forEach(([a, kind], i) => {
    const row = Math.floor(i / perRow)
    const inRow = Math.min(perRow, all.length - row * perRow)
    const x = (i % perRow - (inRow - 1) / 2) * gap + (row % 2 ? gap / 2 : 0)
    bots.push({ id: a, name: shortName(a), kind, color: color(a), home: [x, 1.6 + row * 1.5] })
  })
  return bots
}

const DOCK_DISTANCE = 2.3

function dock(station: StationId, slot: number, count: number): [number, number] {
  // One bot docks straight in front. A group stands on an arc in front of the station (camera side) whose radius
  // grows with the group, so neighbours stay about two bot widths apart and sit at different depths.
  const [sx, sz] = stationPos(station)
  if (count <= 1) return [sx, sz + DOCK_DISTANCE]
  const r = DOCK_DISTANCE + 0.35 * count
  const spread = Math.min(2.6, (2.1 * (count - 1)) / r) // total arc in radians
  const a = -spread / 2 + (slot / (count - 1)) * spread
  return [sx + Math.sin(a) * r, sz + Math.cos(a) * r]
}

interface Step {
  at: number // seconds into the ring
  bot: string
  to: [number, number] | "home"
  task: string | null
}

export interface Phase {
  at: number
  text: string
}

const RING_SECONDS = 12
const PULSE_AT = 6.9

function script(p: Play): { steps: Step[]; phases: Phase[]; settleAt: number } {
  const steps: Step[] = []
  const n = p.legs.length
  const closer = shortName(p.closer)
  p.legs.forEach((a, i) => {
    steps.push({ at: 0.2 + i * 0.25, bot: a, to: dock("board", i, n), task: "posts an offer" })
    const attach = p.version === "v2" ? "attaches its leg" : "signs its leg"
    if (viaMandate(a)) {
      steps.push({ at: 2.8 + i * 0.2, bot: a, to: dock("mandate", 0, 1), task: "signs through its mandate" })
      steps.push({ at: 4.4, bot: a, to: dock("rings", i, n + 1), task: attach })
    } else {
      steps.push({ at: 2.8 + i * 0.2, bot: a, to: dock("rings", i, n + 1), task: attach })
    }
  })
  steps.push({ at: 5.4, bot: p.closer, to: dock("rings", n, n + 1), task: "closes the ring" })
  // v1: the matcher submits execute_intents itself, so it walks to the Verifier. v2: the closer only calls
  // close_ring; the rings contract makes the execute_intents call (drawn as a pulse from the contract to the Verifier).
  if (p.version === "v1") steps.push({ at: 6.9, bot: p.closer, to: dock("verifier", 0, 1), task: "execute_intents" })
  const settleAt = 8.4
  for (const a of p.legs) steps.push({ at: settleAt, bot: a, to: dock("rings", p.legs.indexOf(a), n + 1), task: "settled" })
  if (p.version === "v2") steps.push({ at: 9.4, bot: p.closer, to: dock("reputation", 0, 1), task: "reputation updated" })
  for (const a of p.legs) steps.push({ at: 10.0, bot: a, to: "home", task: null })
  steps.push({ at: p.version === "v2" ? 11.0 : 10.0, bot: p.closer, to: "home", task: null })
  const names = p.legs.map((a) => shortName(a)).join(", ")
  const phases: Phase[] = [
    { at: 0, text: `${names} post offers on the board` },
    { at: 2.8, text: p.version === "v2" ? "Each leg is attached to the ring, signed by its own wallet" : "Each agent signs its leg of the ring" },
    { at: 5.4, text: p.version === "v2" ? `${closer} calls close_ring on the rings contract` : `${closer} closes the ring` },
    {
      at: 6.9,
      text: p.version === "v2" ? "The rings contract settles every leg in one execute_intents call" : `${closer} submits one execute_intents call to the Verifier`,
    },
    { at: settleAt, text: `Settled: ${n} agents traded in one transaction` },
  ]
  return { steps, phases, settleAt }
}

export interface BotNow {
  target: [number, number]
  task: string | null
  hopAt: number | null // seconds (scene clock) when the settle hop started
  inRing: boolean
  raise: boolean // label above the head instead of under the feet (alternate ring members)
}

export interface DirectorNow {
  play: Play | null
  phase: string
  settled: boolean
  focus: string | null // bot the camera follows
  pulse: number | null // v2: progress 0..1 of the execute_intents call travelling rings contract -> Verifier
}

/** Plays rings back to back on the scene clock (seconds). */
export class Director {
  private loop: Play[] = []
  private priority: Play[] = []
  private known = new Set<string>()
  private loopIx = -1
  private cur: { play: Play; start: number; steps: Step[]; phases: Phase[]; settleAt: number } | null = null
  private homes = new Map<string, [number, number]>()
  private lastT = -1
  private bots = new Map<string, BotNow>()
  now: DirectorNow = { play: null, phase: "", settled: false, focus: null, pulse: null }

  setBots(defs: BotDef[]) {
    this.homes = new Map(defs.map((b) => [b.id, b.home]))
    this.lastT = -1
  }

  /** Recorded or live plays. Live rings not seen before jump the queue. */
  setPlays(plays: Play[], live: boolean) {
    const all = V2_PLAY ? [V2_PLAY, ...plays.filter((p) => p.id !== V2_PLAY.id)] : plays
    const first = this.known.size === 0
    for (const p of all) {
      if (this.known.has(p.id)) continue
      this.known.add(p.id)
      if (live && !first) this.priority.push(p)
    }
    this.loop = all
  }

  private start(t: number) {
    let play = this.priority.shift()
    if (!play) {
      if (this.loop.length === 0) {
        this.cur = null
        return
      }
      this.loopIx = (this.loopIx + 1) % this.loop.length
      play = this.loop[this.loopIx]
    }
    this.cur = { play, start: t, ...script(play) }
  }

  update(t: number) {
    if (t === this.lastT) return
    this.lastT = t
    if (!this.cur || t - this.cur.start >= RING_SECONDS) this.start(t)
    const c = this.cur
    this.bots.clear()
    if (!c) {
      this.now = { play: null, phase: "", settled: false, focus: null, pulse: null }
      return
    }
    const lt = t - c.start
    const members = new Set([...c.play.legs, c.play.closer])
    const order = new Map([...c.play.legs, c.play.closer].map((a, i) => [a, i] as const))
    for (const s of c.steps) {
      if (s.at > lt) continue
      const home = this.homes.get(s.bot) ?? [0, 0]
      this.bots.set(s.bot, {
        target: s.to === "home" ? home : s.to,
        task: s.task,
        hopAt: lt >= c.settleAt ? c.start + c.settleAt : null,
        inRing: members.has(s.bot),
        raise: order.get(s.bot)! % 2 === 1,
      })
    }
    const phase = [...c.phases].reverse().find((p) => p.at <= lt)?.text ?? ""
    this.now = {
      play: c.play,
      phase,
      settled: lt >= c.settleAt,
      focus: lt < 5.2 ? c.play.legs[0] : c.play.closer,
      pulse: c.play.version === "v2" && lt >= PULSE_AT && lt < c.settleAt ? (lt - PULSE_AT) / (c.settleAt - PULSE_AT) : null,
    }
  }

  /** Last computed state, without advancing the clock (for the DOM overlay). */
  peek(id: string): BotNow | null {
    return this.bots.get(id) ?? null
  }

  get(id: string, t: number): BotNow {
    this.update(t)
    return this.bots.get(id) ?? { target: this.homes.get(id) ?? [0, 0], task: null, hopAt: null, inRing: false, raise: false }
  }
}
