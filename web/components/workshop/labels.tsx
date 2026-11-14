"use client"

// Screen-space labels for the workshop (stands in for drei's <Html>, which web/ doesn't ship).
// 3D parts register an anchor Object3D under a key; the overlay registers a DOM element under the
// same key; <LabelProjector> moves each element to its anchor's projected position every frame.

import { createContext, useCallback, useContext, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Object3D, Vector3, type Camera } from "three"

export interface LabelStore {
  anchors: Map<string, Object3D>
  els: Map<string, HTMLElement>
}

export const newLabelStore = (): LabelStore => ({ anchors: new Map(), els: new Map() })

export const LabelContext = createContext<LabelStore | null>(null)

/** Ref callback for a 3D anchor (place it where the label should sit). */
export function useLabel(key: string) {
  const store = useContext(LabelContext)
  return useCallback(
    (o: Object3D | null) => {
      if (!store) return
      if (o) store.anchors.set(key, o)
      else store.anchors.delete(key)
    },
    [store, key],
  )
}

/** Ref callback for the DOM element that shows the label. */
export function labelEl(store: LabelStore, key: string) {
  return (el: HTMLElement | null) => {
    if (el) store.els.set(key, el)
    else store.els.delete(key)
  }
}

const v = new Vector3()

/** Moves each label element to its anchor's projected position (skips unchanged ones). */
function project(store: LabelStore, camera: Camera, width: number, height: number, last: Map<string, string>) {
  for (const [key, el] of store.els) {
    const o = store.anchors.get(key)
    let t = "translate(-9999px,-9999px)"
    if (o && o.visible) {
      o.getWorldPosition(v)
      v.project(camera)
      if (v.z < 1 && v.x > -1.2 && v.x < 1.2 && v.y > -1.2 && v.y < 1.2) {
        const x = (v.x * 0.5 + 0.5) * width
        const y = (-v.y * 0.5 + 0.5) * height
        t = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,${el.dataset.align === "bottom" ? "-100%" : "0"})`
      }
    }
    if (last.get(key) !== t) {
      el.style.transform = t
      last.set(key, t)
    }
  }
}

export function LabelProjector({ store }: { store: LabelStore }) {
  const { camera, size } = useThree()
  const [last] = useState(() => new Map<string, string>())
  useFrame(() => project(store, camera, size.width, size.height, last))
  return null
}
