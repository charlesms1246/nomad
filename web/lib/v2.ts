"use client";

// Nomad v2: the open rings contract (contracts/rings), read straight from testnet RPC by the browser.
// Anyone proposes a ring; each agent attaches its own signed leg in any wallet standard; anyone closes
// it with one execute_intents (called by the contract) and earns the legs' tips.

import type { TokenMeta } from "./types";
import { inspectSettlement, runCheck, sameDiff, useCheck, viewCall, type CheckState, type Diff } from "./verify";

export const RINGS_CONTRACT = "rings.nomadswarm.testnet";
export const VERIFIER = "intents.nomadswarm.testnet";
export const NEARBLOCKS_API = "https://api-testnet.nearblocks.io/v1";

/** config/testnet.json tokens (no USD prices on this page). */
export const V2_TOKENS: TokenMeta[] = [
  { id: "nep141:wnear.nomadswarm.testnet", symbol: "wNEAR", decimals: 24, priceUsd: null },
  { id: "nep141:usdc.nomadswarm.testnet", symbol: "USDC", decimals: 6, priceUsd: null },
  { id: "nep141:usdt.nomadswarm.testnet", symbol: "USDT", decimals: 6, priceUsd: null },
  { id: "nep141:btc.nomadswarm.testnet", symbol: "BTC", decimals: 8, priceUsd: null },
  { id: "nep141:zec.nomadswarm.testnet", symbol: "ZEC", decimals: 8, priceUsd: null },
];

/* ---------- contract shapes (contracts/rings/src/lib.rs) ---------- */

export interface V2Leg {
  agent: string; // NEAR account, 64-hex implicit id, or 0x address
  give: string;
  give_amt: string;
  get: string;
  get_amt: string;
  tip: { token: string; amt: string } | null;
}

export type V2Status = "Open" | "Closing" | "Settled" | "Failed";

export interface V2Ring {
  id: string;
  proposer: string;
  legs: V2Leg[];
  deadline_ms: number;
  signed: (string | null)[];
  standards: (string | null)[];
  status: V2Status;
  closer: string | null;
  close_attempts: number;
  created_ms: number;
  settled_ms: number | null;
}

export interface V2Reputation {
  agent_uri: string | null;
  registered_by: string | null;
  rings_settled: number;
  rings_closed: number;
  legs_in_failed_closes: number;
}

export interface V2Config {
  owner: string;
  verifier: string;
  fee_pips: number;
  rings: number;
  settled: number;
}

export const fetchRings = (from = 0, limit = 20) => viewCall<V2Ring[]>(RINGS_CONTRACT, "rings", { from, limit });
export const fetchConfig = () => viewCall<V2Config>(RINGS_CONTRACT, "config");
export const fetchReputation = (agent: string) => viewCall<V2Reputation>(RINGS_CONTRACT, "reputation", { agent });

/* ---------- wallet standards ---------- */

export interface Wallet {
  label: string; // "NEAR", "Ethereum wallet", "Solana-style"
  standard: string | null; // as attached; null when not attached yet
  inferred: boolean; // true when guessed from the id format because no leg is attached
}

const LABELS: Record<string, string> = {
  nep413: "NEAR",
  erc191: "Ethereum wallet",
  raw_ed25519: "Solana-style",
  tip191: "Tron wallet",
  sep53: "Stellar wallet",
  ton_connect: "TON wallet",
  webauthn: "Passkey",
};

export function walletOf(standard: string | null, agent: string): Wallet {
  if (standard) return { label: LABELS[standard] ?? standard, standard, inferred: false };
  if (/^0x[0-9a-f]{40}$/i.test(agent)) return { label: "Ethereum wallet", standard: null, inferred: true };
  if (/^[0-9a-f]{64}$/.test(agent)) return { label: "ed25519 key", standard: null, inferred: true };
  return { label: "NEAR", standard: null, inferred: false }; // a named account can only be a NEAR account
}

export function shortId(id: string): string {
  if (/^0x[0-9a-f]{40}$/i.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  return id.replace(/\.nomadswarm\.testnet$/, "");
}

export const isStranger = (r: V2Ring) => !!r.closer && !r.legs.some((l) => l.agent.toLowerCase() === r.closer!.toLowerCase());

/* ---------- finding a ring's close transaction ---------- */
// The contract doesn't store tx hashes. NearBlocks lists close_ring calls; each candidate is then read
// from RPC (not NearBlocks) and matched on its ring_id argument.

interface NbTxn {
  transaction_hash: string;
  predecessor_account_id: string;
  signer_account_id?: string;
}
let closeList: Promise<NbTxn[]> | null = null;
// tx hash -> the ring it closes and whether its execute_intents succeeded (null if unreadable)
const closeInfo = new Map<string, Promise<{ ringId: string; ok: boolean } | null>>();

function listCloseTxs(): Promise<NbTxn[]> {
  closeList ??= fetch(`${NEARBLOCKS_API}/account/${RINGS_CONTRACT}/txns?method=close_ring&per_page=50`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => {
      if (!r.ok) throw new Error(`NearBlocks HTTP ${r.status}`);
      return r.json();
    })
    .then((j: { txns?: NbTxn[] }) => j.txns ?? [])
    .catch((e) => {
      closeList = null; // retry next time
      throw e;
    });
  return closeList;
}

export interface CloseTx {
  hash: string;
  sender: string;
}

/** The newest close_ring tx for this ring whose execute_intents succeeded, else the newest attempt. */
export async function findCloseTx(ringId: string): Promise<CloseTx | null> {
  const txs = await listCloseTxs();
  let fallback: CloseTx | null = null;
  for (const t of txs) {
    const sender = t.signer_account_id ?? t.predecessor_account_id;
    if (!closeInfo.has(t.transaction_hash)) {
      closeInfo.set(
        t.transaction_hash,
        inspectSettlement(t.transaction_hash, sender, VERIFIER)
          .then((s) => ({ ringId: String(s.txArgs?.ring_id ?? ""), ok: s.success }))
          .catch(() => null),
      );
    }
    // Resolve in order (newest first); stop at the first success for this ring.
    const info = await closeInfo.get(t.transaction_hash)!;
    if (info?.ringId !== ringId) continue;
    if (info.ok) return { hash: t.transaction_hash, sender };
    fallback ??= { hash: t.transaction_hash, sender };
  }
  return fallback;
}

/* ---------- re-check a v2 ring against its close transaction ---------- */

export interface V2LegCheck {
  index: number;
  agent: string;
  attachedStandard: string | null; // from the contract
  signedStandard: string | null; // from the execute_intents args
  claimed: Diff;
  signed: Diff | null;
  executed: Diff | null;
  tipClaimed: { token: string; amt: string } | null;
  tipSigned: boolean; // a transfer of exactly the tip to the rings contract was signed
  match: boolean;
}

export interface V2Verification {
  txHash: string;
  closer: string; // tx signer
  stranger: boolean;
  includedHeight: number;
  executedHeight: number | null;
  success: boolean;
  status: string;
  legs: V2LegCheck[];
  tipsPaid: Diff; // token -> amount moved from the rings contract to the closer
  tipsExpected: Diff;
  allMatch: boolean;
  checkedAtMs: number;
}

export async function verifyV2Ring(ring: V2Ring, override?: CloseTx): Promise<V2Verification> {
  const close = override ?? (await findCloseTx(ring.id));
  if (!close) throw new Error("No close_ring transaction found for this ring yet");
  const s = await inspectSettlement(close.hash, close.sender, VERIFIER);
  if (s.txArgs?.ring_id !== ring.id) throw new Error(`That transaction closes ring ${String(s.txArgs?.ring_id ?? "?")}, not this one`);

  const legs: V2LegCheck[] = ring.legs.map((l, i) => {
    const lc = l.agent.toLowerCase();
    const claimed: Diff = { [l.give]: (-BigInt(l.give_amt)).toString(), [l.get]: BigInt(l.get_amt).toString() };
    const sg = s.signed.get(lc) ?? null;
    const e = s.executed.get(lc) ?? null;
    const tipSigned = l.tip
      ? (sg?.transfers ?? []).some((t) => t.receiver === RINGS_CONTRACT && sameDiff(t.tokens, { [l.tip!.token]: BigInt(l.tip!.amt).toString() }))
      : (sg?.transfers.length ?? 0) === 0;
    const standardOk = !!sg && (ring.standards[i] == null || ring.standards[i] === sg.standard);
    return {
      index: i,
      agent: l.agent,
      attachedStandard: ring.standards[i] ?? null,
      signedStandard: sg?.standard ?? null,
      claimed,
      signed: sg?.diff ?? null,
      executed: e,
      tipClaimed: l.tip,
      tipSigned,
      match: s.success
        ? standardOk && sameDiff(claimed, sg?.diff ?? null) && sameDiff(claimed, e) && s.executedIntents.has(lc) && tipSigned
        : standardOk && sameDiff(claimed, sg?.diff ?? null) && !e,
    };
  });

  const tipsPaid: Diff = {};
  for (const ev of s.events) {
    if (ev.standard !== "nep245" || ev.event !== "mt_transfer") continue;
    for (const d of ev.data as { old_owner_id?: string; new_owner_id?: string; token_ids?: string[]; amounts?: string[] }[]) {
      if (d.old_owner_id !== RINGS_CONTRACT || d.new_owner_id !== s.txSigner) continue;
      d.token_ids?.forEach((t, k) => (tipsPaid[t] = (BigInt(tipsPaid[t] ?? "0") + BigInt(d.amounts?.[k] ?? "0")).toString()));
    }
  }
  const tipsExpected: Diff = {};
  for (const l of ring.legs) if (l.tip) tipsExpected[l.tip.token] = (BigInt(tipsExpected[l.tip.token] ?? "0") + BigInt(l.tip.amt)).toString();

  const contractSaysSettled = ring.status === "Settled";
  const tipsOk = !s.success || Object.keys(tipsExpected).length === 0 || sameDiff(tipsPaid, tipsExpected);
  return {
    txHash: close.hash,
    closer: s.txSigner,
    stranger: !ring.legs.some((l) => l.agent.toLowerCase() === s.txSigner.toLowerCase()),
    includedHeight: s.includedHeight,
    executedHeight: s.executedHeight,
    success: s.success,
    status: s.status,
    legs,
    tipsPaid,
    tipsExpected,
    allMatch: s.success === contractSaysSettled && legs.every((l) => l.match) && tipsOk && (!ring.closer || ring.closer === s.txSigner || !s.success),
    checkedAtMs: Date.now(),
  };
}

const key = (ringId: string) => `v2:${ringId}`;
export const recheckV2 = (ring: V2Ring, override?: CloseTx) => runCheck(key(ring.id), () => verifyV2Ring(ring, override));
export const useV2Check = (ringId: string): CheckState<V2Verification> => useCheck<V2Verification>(key(ringId));
