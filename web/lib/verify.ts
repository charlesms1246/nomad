"use client";

// "Re-check on chain": the browser reads a ring's transaction straight from
// testnet RPC and compares what the Verifier executed with what the ring claims.
// Nothing here trusts the matcher API beyond the tx hash and the signer id.

import { useSyncExternalStore } from "react";
import type { AccountId, Ring, TokenId } from "./types";

export const TESTNET_RPC = "https://rpc.testnet.fastnear.com";

export type Diff = Record<TokenId, string>; // signed decimal strings, as in token_diff

export interface LegCheck {
  agent: AccountId;
  role: "agent" | "matcher";
  claimed: Diff | null; // from the ring (null: an account on chain that the ring doesn't list)
  signed: Diff | null; // from the signed NEP-413 message in the tx args
  executed: Diff | null; // from the Verifier's dip4 token_diff event
  intentExecuted: boolean; // listed in the intents_executed event
  match: boolean; // claimed == signed == executed
}

export interface Verification {
  txHash: string;
  txSigner: AccountId;
  receiver: AccountId;
  method: string;
  status: string; // "SuccessValue" or "Failure: …"
  success: boolean;
  includedHeight: number;
  executedHeight: number | null;
  blocksToExec: number | null;
  legs: LegCheck[];
  allMatch: boolean; // chain outcome agrees with ring.status and every leg checks out
  checkedAtMs: number;
}

export type VerifyState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: Verification }
  | { phase: "error"; message: string };

/* ---------- RPC ---------- */

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(TESTNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nomad", method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error?.cause?.name ?? j.error?.data ?? j.error?.message ?? "RPC error");
  return j.result as T;
}

interface TxStatus {
  status: Record<string, unknown>;
  transaction: {
    signer_id: string;
    receiver_id: string;
    actions: ({ FunctionCall?: { method_name: string; args: string } } | string)[];
  };
  transaction_outcome: { block_hash: string };
  receipts_outcome: { block_hash: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }[];
}

const heightCache = new Map<string, number>();
async function blockHeight(hash: string): Promise<number> {
  const hit = heightCache.get(hash);
  if (hit != null) return hit;
  const b = await rpc<{ header: { height: number } }>("block", { block_id: hash });
  heightCache.set(hash, b.header.height);
  return b.header.height;
}

/* ---------- decoding ---------- */

function b64ToString(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function normDiff(d: Record<string, string> | undefined | null): Diff | null {
  if (!d) return null;
  const out: Diff = {};
  for (const [k, v] of Object.entries(d)) out[k] = BigInt(v).toString();
  return out;
}

function sameDiff(a: Diff | null, b: Diff | null): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

interface DipEvent {
  standard: string;
  event: string;
  data: { account_id?: string; diff?: Record<string, string>; intent_hash?: string }[];
}

function events(logs: string[]): DipEvent[] {
  const out: DipEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      out.push(JSON.parse(l.slice("EVENT_JSON:".length)));
    } catch {
      /* not JSON: ignore */
    }
  }
  return out;
}

function claimedDiffs(ring: Ring): Map<AccountId, Diff> {
  const m = new Map<AccountId, Diff>();
  for (const l of ring.legs) m.set(l.agent, { [l.give]: (-BigInt(l.giveAmt)).toString(), [l.get]: BigInt(l.getAmt).toString() });
  if (ring.matcherLeg.amt !== "0") m.set(ring.matcher, { [ring.matcherLeg.token]: BigInt(ring.matcherLeg.amt).toString() });
  return m;
}

export async function verifyRing(ring: Ring): Promise<Verification> {
  if (!ring.txHash) throw new Error("This ring has no transaction hash");
  const sender = ring.txSigner ?? ring.matcher;
  const tx = await rpc<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: ring.txHash, sender_account_id: sender, wait_until: "FINAL" });

  const call = tx.transaction.actions.map((a) => (typeof a === "string" ? null : a.FunctionCall)).find(Boolean);
  if (!call) throw new Error("The transaction has no function call");

  // What was signed: the args of execute_intents.
  const signedBy = new Map<AccountId, Diff>();
  try {
    const args = JSON.parse(b64ToString(call.args)) as { signed?: { payload?: { message?: string } }[] };
    for (const s of args.signed ?? []) {
      const msg = JSON.parse(s.payload?.message ?? "{}") as { signer_id?: string; intents?: { intent: string; diff?: Record<string, string> }[] };
      const td = msg.intents?.find((i) => i.intent === "token_diff");
      if (msg.signer_id && td) signedBy.set(msg.signer_id, normDiff(td.diff)!);
    }
  } catch {
    throw new Error("Could not decode the execute_intents arguments");
  }

  // What the Verifier executed: dip4 events in the receipt logs.
  const executed = new Map<AccountId, Diff>();
  const executedIntents = new Set<AccountId>();
  let execBlock: string | null = null;
  for (const ro of tx.receipts_outcome) {
    for (const ev of events(ro.outcome.logs)) {
      if (ev.standard !== "dip4") continue;
      if (ev.event === "token_diff") {
        execBlock ??= ro.block_hash;
        for (const d of ev.data) if (d.account_id) executed.set(d.account_id, normDiff(d.diff)!);
      }
      if (ev.event === "intents_executed") for (const d of ev.data) if (d.account_id) executedIntents.add(d.account_id);
    }
  }

  const st = tx.status;
  const success = "SuccessValue" in st;
  const panic = JSON.stringify(st).match(/"ExecutionError":"([^"]+)"/)?.[1];
  const status = success ? "SuccessValue" : `Failure: ${panic ?? JSON.stringify(st.Failure ?? st).slice(0, 160)}`;

  const includedHeight = await blockHeight(tx.transaction_outcome.block_hash);
  const executedHeight = execBlock ? await blockHeight(execBlock) : null;

  const claimed = claimedDiffs(ring);
  const accounts = [...claimed.keys(), ...[...signedBy.keys(), ...executed.keys()].filter((a) => !claimed.has(a))];
  const uniq = [...new Set(accounts)];
  const legs: LegCheck[] = uniq.map((agent) => {
    const c = claimed.get(agent) ?? null;
    const s = signedBy.get(agent) ?? null;
    const e = executed.get(agent) ?? null;
    return {
      agent,
      role: agent === ring.matcher ? "matcher" : "agent",
      claimed: c,
      signed: s,
      executed: e,
      intentExecuted: executedIntents.has(agent),
      // Settled: claimed == signed == executed. Failed batch: nothing executed, so the
      // signed leg must equal the claim and nothing may have moved for this account.
      match: success ? sameDiff(c, s) && sameDiff(c, e) && executedIntents.has(agent) : sameDiff(c, s) && !e,
    };
  });

  return {
    txHash: ring.txHash,
    txSigner: tx.transaction.signer_id,
    receiver: tx.transaction.receiver_id,
    method: call.method_name,
    status,
    success,
    includedHeight,
    executedHeight,
    blocksToExec: executedHeight != null ? executedHeight - includedHeight : null,
    legs,
    // The ring's own status must agree with the chain, and every leg must check out.
    allMatch: success === (ring.status === "settled") && legs.length > 0 && legs.every((l) => l.match),
    checkedAtMs: Date.now(),
  };
}

/* ---------- shared store: the table and the detail card show the same result ---------- */

const store = new Map<string, VerifyState>();
const listeners = new Set<() => void>();
const IDLE: VerifyState = { phase: "idle" };

function set(hash: string, s: VerifyState) {
  store.set(hash, s);
  listeners.forEach((l) => l());
}

export function recheck(ring: Ring, opts: { once?: boolean } = {}) {
  const h = ring.txHash;
  const cur = store.get(h ?? "")?.phase;
  if (!h || cur === "checking" || (opts.once && cur)) return;
  set(h, { phase: "checking" });
  verifyRing(ring).then(
    (result) => set(h, { phase: "done", result }),
    (e: Error) => set(h, { phase: "error", message: e.message || String(e) }),
  );
}

export function useVerification(txHash: string | null): VerifyState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (txHash ? (store.get(txHash) ?? IDLE) : IDLE),
    () => IDLE,
  );
}

/** Only real chain data can be re-checked; mock and sim hashes are invented. */
export function canRecheck(source: string, ring: Ring): boolean {
  return !!ring.txHash && (source === "live" || source === "recorded");
}
