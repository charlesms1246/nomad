"use client";

// One v2 ring's whole story, read from testnet for the landing-page replay:
// proposed -> legs attached (per wallet standard) -> closed by a stranger -> settled in one
// execute_intents -> tips paid to the closer -> reputation now.
// The contract stores no tx hashes, so the propose/attach txs are found through NearBlocks and
// then read from RPC (matched on the propose return value and on the attach arguments).

import { rpc, type Diff } from "./verify";
import { NEARBLOCKS_API, RINGS_CONTRACT, fetchReputation, verifyV2Ring, type V2Reputation, type V2Ring } from "./v2";
import { viewCall } from "./verify";

export const DEFAULT_REPLAY_RING = "f5d3e16fca764b6f752ab5d3254b67fd"; // a01 (NEAR) + 0x (Ethereum) + hex (Solana-style), closed by k4

export interface ReplayData {
  source: "live" | "recorded";
  ring: V2Ring;
  proposeTx: string | null;
  attach: ({ tx: string; relayedBy: string } | null)[]; // per leg index
  close: {
    tx: string;
    closer: string;
    stranger: boolean;
    includedHeight: number;
    executedHeight: number | null;
    success: boolean;
    status: string;
    signedStandards: (string | null)[]; // per leg, decoded from the execute_intents receipt
    allMatch: boolean;
  } | null;
  tipsPaid: Diff;
  reputation: Record<string, V2Reputation>;
  readAtMs: number;
}

interface NbTxn {
  transaction_hash: string;
  signer_account_id?: string;
  predecessor_account_id: string;
}

async function listTxns(method: string, perPage = 25): Promise<NbTxn[]> {
  const r = await fetch(`${NEARBLOCKS_API}/account/${RINGS_CONTRACT}/txns?method=${method}&per_page=${perPage}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`NearBlocks HTTP ${r.status}`);
  return ((await r.json()) as { txns?: NbTxn[] }).txns ?? [];
}

interface TxLite {
  status: { SuccessValue?: string };
  transaction: { signer_id: string; actions: ({ FunctionCall?: { method_name: string; args: string } } | string)[] };
}

const txCache = new Map<string, Promise<TxLite | null>>();
function txStatus(hash: string, sender: string): Promise<TxLite | null> {
  if (!txCache.has(hash)) {
    txCache.set(hash, rpc<TxLite>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" }).catch(() => null));
  }
  return txCache.get(hash)!;
}

const b64json = (b64: string | undefined): unknown => {
  if (!b64) return null;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
};
const argsOf = (t: TxLite) => {
  const fc = t.transaction.actions.map((a) => (typeof a === "string" ? undefined : a.FunctionCall)).find(Boolean);
  return fc ? (b64json(fc.args) as Record<string, unknown> | null) : null;
};

/** Read candidates in small batches, newest first, until `done` says stop. */
async function scan(txns: NbTxn[], visit: (t: TxLite, n: NbTxn) => boolean) {
  for (let i = 0; i < txns.length; i += 5) {
    const batch = txns.slice(i, i + 5);
    const res = await Promise.all(batch.map((n) => txStatus(n.transaction_hash, n.signer_account_id ?? n.predecessor_account_id)));
    for (let j = 0; j < batch.length; j++) if (res[j] && visit(res[j]!, batch[j]!)) return;
  }
}

async function findProposeTx(ringId: string): Promise<string | null> {
  let found: string | null = null;
  await scan(await listTxns("propose_ring"), (t, n) => {
    if (b64json(t.status.SuccessValue) === ringId) found = n.transaction_hash;
    return !!found;
  });
  return found;
}

async function findAttachTxs(ringId: string, k: number): Promise<ReplayData["attach"]> {
  const out: ReplayData["attach"] = Array(k).fill(null);
  await scan(await listTxns("attach_leg", 50), (t, n) => {
    const a = argsOf(t);
    // newest first: keep the newest successful attach per index (a re-attach after a failed close replaces the leg)
    if (a?.ring_id === ringId && typeof a.index === "number" && !out[a.index] && "SuccessValue" in t.status) {
      out[a.index] = { tx: n.transaction_hash, relayedBy: t.transaction.signer_id };
    }
    return out.every(Boolean);
  });
  return out;
}

/**
 * `known`: tx hashes already known for this ring (e.g. the saved copy). A settled ring's hashes never
 * change, so known ones skip NearBlocks (rate-limited) and the close is re-verified by hash over RPC.
 */
export async function loadReplay(ringId: string, known?: ReplayData | null): Promise<ReplayData> {
  const ring = await viewCall<V2Ring | null>(RINGS_CONTRACT, "get_ring", { ring_id: ringId });
  if (!ring) throw new Error(`Ring ${ringId} not found on ${RINGS_CONTRACT}`);
  const closed = ring.status === "Settled" || ring.status === "Failed";
  const k = known && known.ring.id === ringId ? known : null;
  const knownClose = k?.close && ring.closer === k.close.closer ? { hash: k.close.tx, sender: k.close.closer } : undefined;
  const [check, proposeTx, attach] = await Promise.all([
    closed ? verifyV2Ring(ring, knownClose).catch(() => null) : Promise.resolve(null),
    k?.proposeTx ? Promise.resolve(k.proposeTx) : findProposeTx(ringId).catch(() => null),
    k && k.attach.every(Boolean)
      ? Promise.resolve(k.attach)
      : findAttachTxs(ringId, ring.legs.length).catch(() => Array(ring.legs.length).fill(null)),
  ]);
  const accounts = [...ring.legs.map((l) => l.agent), ...(ring.closer ? [ring.closer] : [])];
  const reps = await Promise.all(accounts.map(async (a) => [a, await fetchReputation(a)] as const));
  return {
    source: "live",
    ring,
    proposeTx,
    attach,
    close: check
      ? {
          tx: check.txHash,
          closer: check.closer,
          stranger: check.stranger,
          includedHeight: check.includedHeight,
          executedHeight: check.executedHeight,
          success: check.success,
          status: check.status,
          signedStandards: check.legs.map((l) => l.signedStandard),
          allMatch: check.allMatch,
        }
      : null,
    tipsPaid: check?.tipsPaid ?? {},
    reputation: Object.fromEntries(reps),
    readAtMs: Date.now(),
  };
}
