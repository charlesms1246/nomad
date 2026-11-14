"use client";

import { useEffect, useState } from "react";
import { fetchConfig, fetchRings, isStranger, walletOf, type V2Config, type V2Ring } from "./v2";

export interface LandingChain {
  rings: V2Ring[]; // newest first, up to 20
  config: V2Config;
}

let shared: Promise<LandingChain> | null = null;
/** rings(0, 20) and config(), fetched once per page load and shared by the marquee and the facts. */
export function loadLandingChain(): Promise<LandingChain> {
  shared ??= Promise.all([fetchRings(0, 20), fetchConfig()])
    .then(([rings, config]) => ({ rings, config }))
    .catch((e) => {
      shared = null;
      throw e;
    });
  return shared;
}

export function useLandingChain(): LandingChain | null | "error" {
  const [state, setState] = useState<LandingChain | null | "error">(null);
  useEffect(() => {
    let stop = false;
    loadLandingChain().then(
      (d) => !stop && setState(d),
      () => !stop && setState("error"),
    );
    return () => {
      stop = true;
    };
  }, []);
  return state;
}

/** Wallet labels used in a ring, in leg order, without repeats. */
export function walletMix(r: V2Ring): string[] {
  return [...new Set(r.legs.map((l, i) => walletOf(r.standards[i] ?? null, l.agent).label))];
}

export interface ChainFacts {
  settled: number; // config().settled
  proposed: number; // config().rings
  standards: string[]; // wallet labels seen in the settled rings we loaded
  settledLoaded: number;
  closedByStranger: number; // among the settled rings we loaded
}

export function factsOf(d: LandingChain): ChainFacts {
  const settled = d.rings.filter((r) => r.status === "Settled");
  const std = new Set<string>();
  for (const r of settled) r.standards.forEach((s, i) => s && std.add(walletOf(s, r.legs[i].agent).label));
  return {
    settled: d.config.settled,
    proposed: d.config.rings,
    standards: [...std],
    settledLoaded: settled.length,
    closedByStranger: settled.filter(isStranger).length,
  };
}
