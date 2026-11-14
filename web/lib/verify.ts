"use client";

// "Re-check on chain": the browser reads a settlement transaction straight from testnet RPC and
// compares what the Verifier executed with what the ring claims. Nothing here trusts the matcher
// API or the rings contract beyond the tx hash and the signer id.
//
// Works for both shapes:
//   matcher: the tx itself calls execute_intents on the Verifier (matcher or delegated relayer key);
//   rings contract: the tx calls close_ring on rings.nomadswarm.testnet, whose receipt calls execute_intents.
// Signed legs are decoded per wallet standard (nep413, erc191, raw_ed25519, ...).

import { useSyncExternalStore } from "react";
import type { TokenId } from "./types";

export const TESTNET_RPC = "https://rpc.testnet.fastnear.com";

export type Diff = Record<TokenId, string>; // signed decimal strings, as in token_diff

/* ---------- RPC ---------- */

export async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(TESTNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nomad", method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error?.cause?.info?.error_message ?? j.error?.cause?.name ?? j.error?.data ?? j.error?.message ?? "RPC error");
  return j.result as T;
}

/** A contract view call (`call_function`), JSON in and out. */
export async function viewCall<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

interface FnCall {
  method_name: string;
  args: string;
}
type Action = { FunctionCall?: FnCall } | string;
interface TxStatus {
  status: Record<string, unknown>;
  transaction: { signer_id: string; receiver_id: string; actions: Action[] };
  transaction_outcome: { block_hash: string };
  receipts?: { receipt_id: string; predecessor_id: string; receiver_id: string; receipt: { Action?: { actions: Action[] } } }[];
  receipts_outcome: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }[];
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
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function normDiff(d: Record<string, string> | undefined | null): Diff | null {
  if (!d) return null;
  const out: Diff = {};
  for (const [k, v] of Object.entries(d)) out[k] = BigInt(v).toString();
  return out;
}

export function sameDiff(a: Diff | null, b: Diff | null): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export interface ChainEvent {
  executor: string;
  standard: string;
  event: string;
  data: Record<string, unknown>[];
}

function eventsOf(executor: string, logs: string[]): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(l.slice("EVENT_JSON:".length));
      out.push({ executor, standard: e.standard, event: e.event, data: e.data ?? [] });
    } catch {
      /* not JSON */
    }
  }
  return out;
}

export interface SignedLeg {
  standard: string; // "nep413", "erc191", "raw_ed25519", ...
  diff: Diff | null;
  transfers: { receiver: string; tokens: Diff }[];
}

/** signer_id (lowercased) -> what that signer signed, from the execute_intents args. */
function decodeSigned(argsB64: string): Map<string, SignedLeg> {
  const out = new Map<string, SignedLeg>();
  let args: { signed?: { standard: string; payload: unknown }[] };
  try {
    args = JSON.parse(b64ToString(argsB64));
  } catch {
    throw new Error("Could not decode the execute_intents arguments");
  }
  for (const s of args.signed ?? []) {
    // nep413 wraps the message in payload.message; erc191, raw_ed25519 and the others sign payload itself.
    const msgStr = s.standard === "nep413" ? (s.payload as { message?: string })?.message : typeof s.payload === "string" ? s.payload : undefined;
    if (!msgStr) continue;
    const msg = JSON.parse(msgStr) as { signer_id?: string; intents?: { intent: string; diff?: Record<string, string>; receiver_id?: string; tokens?: Record<string, string> }[] };
    if (!msg.signer_id) continue;
    out.set(msg.signer_id.toLowerCase(), {
      standard: s.standard,
      diff: normDiff(msg.intents?.find((i) => i.intent === "token_diff")?.diff),
      transfers: (msg.intents ?? []).filter((i) => i.intent === "transfer").map((i) => ({ receiver: i.receiver_id ?? "", tokens: normDiff(i.tokens) ?? {} })),
    });
  }
  return out;
}

export interface Settlement {
  txHash: string;
  txSigner: string;
  txReceiver: string;
  txMethod: string;
  txArgs: Record<string, unknown> | null;
  /** True when the tx calls another contract whose receipt calls execute_intents (the rings contract). */
  viaContract: boolean;
  includedHeight: number;
  /** Outcome of the execute_intents receipt itself (not the outer tx). */
  success: boolean;
  status: string; // "SuccessValue" or "Failure: …"
  executedHeight: number | null; // block of the execute_intents receipt
  signed: Map<string, SignedLeg>; // key: lowercased signer_id
  executed: Map<string, Diff>; // key: lowercased account id, from dip4 token_diff
  executedIntents: Set<string>; // lowercased account ids in intents_executed
  events: ChainEvent[]; // every event in the tx, in receipt order
}

const fnOf = (acts: Action[] | undefined) => acts?.map((a) => (typeof a === "string" ? undefined : a.FunctionCall)).find(Boolean);

/** Read a tx and locate the Verifier's execute_intents receipt in it, directly or behind a contract. */
export async function inspectSettlement(txHash: string, sender: string, verifier: string): Promise<Settlement> {
  const tx = await rpc<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" });
  const top = fnOf(tx.transaction.actions);
  if (!top) throw new Error("The transaction has no function call");
  let txArgs: Record<string, unknown> | null = null;
  try {
    txArgs = JSON.parse(b64ToString(top.args));
  } catch {
    /* binary args */
  }

  // Find the execute_intents call: the tx itself, or a receipt sent to the Verifier.
  const viaContract = !(tx.transaction.receiver_id === verifier && top.method_name === "execute_intents");
  let execArgs: string | null = viaContract ? null : top.args;
  let execReceiptId: string | null = null;
  if (viaContract) {
    for (const r of tx.receipts ?? []) {
      const fc = r.receiver_id === verifier ? fnOf(r.receipt.Action?.actions) : undefined;
      if (fc?.method_name === "execute_intents") {
        execArgs = fc.args;
        execReceiptId = r.receipt_id;
        break;
      }
    }
  }
  if (!execArgs) throw new Error("This transaction never called execute_intents on the Verifier");

  const execOutcome = viaContract
    ? tx.receipts_outcome.find((o) => o.id === execReceiptId)
    : tx.receipts_outcome.find((o) => o.outcome.executor_id === verifier);
  const st = execOutcome?.outcome.status ?? tx.status;
  const success = "SuccessValue" in st;
  const panic = JSON.stringify(st).match(/"ExecutionError":"([^"]+)"/)?.[1];
  const status = success ? "SuccessValue" : `Failure: ${panic ?? JSON.stringify(st.Failure ?? st).slice(0, 160)}`;

  // Only the execute_intents receipt's dip4 events count as "executed".
  const executed = new Map<string, Diff>();
  const executedIntents = new Set<string>();
  for (const ev of execOutcome ? eventsOf(execOutcome.outcome.executor_id, execOutcome.outcome.logs) : []) {
    if (ev.standard !== "dip4") continue;
    for (const d of ev.data as { account_id?: string; diff?: Record<string, string> }[]) {
      if (!d.account_id) continue;
      if (ev.event === "token_diff") executed.set(d.account_id.toLowerCase(), normDiff(d.diff)!);
      if (ev.event === "intents_executed") executedIntents.add(d.account_id.toLowerCase());
    }
  }

  return {
    txHash,
    txSigner: tx.transaction.signer_id,
    txReceiver: tx.transaction.receiver_id,
    txMethod: top.method_name,
    txArgs,
    viaContract,
    includedHeight: await blockHeight(tx.transaction_outcome.block_hash),
    success,
    status,
    executedHeight: execOutcome ? await blockHeight(execOutcome.block_hash) : null,
    signed: decodeSigned(execArgs),
    executed,
    executedIntents,
    events: tx.receipts_outcome.flatMap((o) => eventsOf(o.outcome.executor_id, o.outcome.logs)),
  };
}

export type CheckState<T> = { phase: "idle" } | { phase: "checking" } | { phase: "done"; result: T } | { phase: "error"; message: string };

/* ---------- shared store: every view of the same check shows the same result ---------- */

const store = new Map<string, CheckState<unknown>>();
const listeners = new Set<() => void>();
const IDLE = { phase: "idle" } as const;

function set(key: string, s: CheckState<unknown>) {
  store.set(key, s);
  listeners.forEach((l) => l());
}

/** Run `fn` once per key at a time; `once` skips keys that already have a state. */
export function runCheck<T>(key: string, fn: () => Promise<T>, opts: { once?: boolean } = {}) {
  const cur = store.get(key)?.phase;
  if (cur === "checking" || (opts.once && cur)) return;
  set(key, { phase: "checking" });
  fn().then(
    (result) => set(key, { phase: "done", result }),
    (e: Error) => set(key, { phase: "error", message: e.message || String(e) }),
  );
}

export function useCheck<T>(key: string | null): CheckState<T> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => ((key ? store.get(key) : undefined) ?? IDLE) as CheckState<T>,
    () => IDLE,
  );
}
