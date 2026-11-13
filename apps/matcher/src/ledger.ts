// LedgerChain: an in-memory Chain for the sim when @nomad/verifier-model is not wired in.
// It applies token_diffs in order with the Verifier's fee rule (BUILD_PLAN C1), panics on a
// negative balance, enforces per-token zero-sum after fees, and rejects reused nonces.
// It does NOT verify signatures; the verifier model does (and the differential test checks it).

import { feeOf } from "@nomad/ringfinder";
import type { MultiPayload, TokenId } from "@nomad/agent";
import type { Chain, ExecResult, SimResult } from "./chain.js";

export class LedgerChain implements Chain {
  readonly network = "sim" as const;
  bal = new Map<string, bigint>();
  usedNonces = new Set<string>();
  height = 1;
  txs = 0;
  feeCollected = new Map<TokenId, bigint>();

  constructor(
    readonly verifierId = "intents.nomadswarm.testnet",
    private fee = 1,
    private saltHex = "252812b3",
  ) {}

  async feePips() {
    return this.fee;
  }
  async salt() {
    return this.saltHex;
  }
  async balances(account: string, tokens: TokenId[]) {
    return Object.fromEntries(tokens.map((t) => [t, this.bal.get(`${account}|${t}`) ?? 0n]));
  }

  credit(account: string, token: TokenId, amt: bigint) {
    const k = `${account}|${token}`;
    this.bal.set(k, (this.bal.get(k) ?? 0n) + amt);
  }

  private apply(signed: MultiPayload[], commit: boolean): SimResult & { next?: Map<string, bigint> } {
    const next = new Map(this.bal);
    const net: Record<TokenId, bigint> = {};
    const fees: Record<TokenId, bigint> = {};
    const nonces = new Set<string>();
    for (const s of signed) {
      let m: { signer_id: string; deadline: string; intents: { intent: string; diff: Record<string, string> }[] };
      try {
        m = JSON.parse(s.payload.message);
      } catch {
        return { ok: false, error: "invalid payload" };
      }
      if (s.payload.recipient !== this.verifierId) return { ok: false, error: "invalid recipient" };
      if (s.payload.nonce) {
        if (this.usedNonces.has(s.payload.nonce) || nonces.has(s.payload.nonce)) return { ok: false, error: "nonce was already used" };
        nonces.add(s.payload.nonce);
      }
      for (const it of m.intents) {
        if (it.intent !== "token_diff") return { ok: false, error: `unsupported intent ${it.intent}` };
        const entries = Object.entries(it.diff);
        if (entries.length === 0) return { ok: false, error: "invalid intent" };
        for (const [t, v] of entries) {
          const d = BigInt(v);
          if (d === 0n) return { ok: false, error: "invalid intent" };
          const k = `${m.signer_id}|${t}`;
          const nb = (next.get(k) ?? 0n) + d;
          if (nb < 0n) return { ok: false, error: "insufficient balance or overflow" };
          next.set(k, nb);
          if (d < 0n) {
            const f = feeOf(-d, this.fee);
            fees[t] = (fees[t] ?? 0n) + f;
            net[t] = (net[t] ?? 0n) + d + f;
          } else net[t] = (net[t] ?? 0n) + d;
        }
      }
    }
    const bad = Object.entries(net).find(([, v]) => v !== 0n);
    if (bad) return { ok: false, error: `invariant violated: unmatched deltas ${bad[0]} ${bad[1]}` };
    if (commit) {
      this.bal = next;
      for (const n of nonces) this.usedNonces.add(n);
      for (const [t, f] of Object.entries(fees)) this.feeCollected.set(t, (this.feeCollected.get(t) ?? 0n) + f);
    }
    return { ok: true, intentsExecuted: signed.length };
  }

  async simulate(signed: MultiPayload[]): Promise<SimResult> {
    const { next: _n, ...r } = this.apply(signed, false);
    return r;
  }

  async execute(signed: MultiPayload[]): Promise<ExecResult> {
    const r = this.apply(signed, true);
    this.height++;
    if (!r.ok) return { ok: false, txHash: null, blockHeight: this.height, blocksToExec: null, gasBurntTgas: null, error: r.error };
    this.txs++;
    return {
      ok: true,
      txHash: `sim-${this.txs.toString().padStart(6, "0")}`,
      blockHeight: this.height,
      blocksToExec: 0,
      // ~5.3 Tgas for 2 signers measured on mainnet (F16); ~20.5 Tgas for a 3-signer batch (C3)
      gasBurntTgas: null,
    };
  }
}
