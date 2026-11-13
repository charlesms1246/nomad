// ModelChain: the sim's Chain backed by @nomad/verifier-model, the TypeScript model of the defuse
// Verifier that is differential-tested against simulate_intents on our testnet deployment
// (docs/MEASUREMENTS.md: 500/500 batches agree). Unlike LedgerChain it checks everything the
// real Verifier checks: real ed25519 NEP-413 signatures, registered keys, salts, versioned-nonce
// deadlines and reuse, message deadlines, sequential balances, the 1-pip fee and the zero-sum
// invariant (with the same error strings).
//
// Every sim account gets a throwaway ed25519 key, derived deterministically from (seed, account)
// so runs are reproducible, and registered in the model like `add_public_key` would on chain.
// Time is the sim clock, not wall time, so the sim's deadlines are checked consistently.

import { createHash } from "node:crypto";
import { fromSeed, signTokenDiff, type KeyPair } from "@nomad/intents";
import { VerifierModel } from "@nomad/verifier-model";
import type { MultiPayload, TokenId } from "@nomad/agent";
import type { Chain, DiffSigner, ExecResult, SimResult } from "./chain.js";

/** K3 fit on our testnet Verifier (docs/MEASUREMENTS.md): Tgas ≈ 3.25 + 2.53 per signer. */
export const gasTgasFor = (signers: number) => Math.round((3.25 + 2.53 * signers) * 100) / 100;

export interface ModelChainOpts {
  verifierId?: string;
  feePips?: number;
  feeCollector?: string;
  salt?: string;
  /** Sim clock in ms (deadline checks). Defaults to wall time. */
  now?: () => number;
  /** Seed for the per-account keys. */
  seed?: number | string;
}

export class ModelChain implements Chain {
  readonly network = "sim" as const;
  readonly verifierId: string;
  readonly model: VerifierModel;
  height = 1;
  txs = 0;
  private keys = new Map<string, KeyPair>();
  private readonly saltHex: string;
  private readonly seed: string;

  constructor(o: ModelChainOpts = {}) {
    this.verifierId = o.verifierId ?? "intents.nomadswarm.testnet";
    this.saltHex = o.salt ?? "252812b3";
    this.seed = String(o.seed ?? 0);
    const now = o.now;
    this.model = new VerifierModel({
      verifierId: this.verifierId,
      feePips: o.feePips ?? 1,
      feeCollector: o.feeCollector ?? "fees.nomadswarm.testnet",
      validSalts: [this.saltHex],
      now: now ? () => new Date(now()) : undefined,
    });
  }

  async feePips() {
    return this.model.cfg.feePips;
  }
  async salt() {
    return this.saltHex;
  }
  async balances(account: string, tokens: TokenId[]) {
    return Object.fromEntries(tokens.map((t) => [t, this.model.balanceOf(account, t)]));
  }

  /** Fund (or, with a negative amount, debit) an account inside the model, like a deposit. */
  credit(account: string, token: TokenId, amt: bigint) {
    this.model.deposit(account, token, amt);
  }

  /** The account's throwaway key, created and registered on first use. */
  keyOf(account: string): KeyPair {
    let kp = this.keys.get(account);
    if (!kp) {
      kp = fromSeed(new Uint8Array(createHash("sha256").update(`nomad-sim:${this.seed}:${account}`).digest()));
      this.keys.set(account, kp);
      this.model.addPublicKey(account, kp.publicKeyStr);
    }
    return kp;
  }

  /** A real NEP-413 signer for `account` (agents' legs and the matcher's own leg). */
  signer(account: string): DiffSigner {
    const kp = this.keyOf(account);
    return (a) =>
      signTokenDiff({
        signerId: account,
        secretKey: kp.secretKeyStr,
        verifierId: a.verifierId,
        salt: a.salt,
        deadline: a.deadline,
        diff: a.diff,
        memo: a.memo,
        nonce: a.nonce,
      }) as MultiPayload;
  }

  async simulate(signed: MultiPayload[]): Promise<SimResult> {
    const r = this.model.simulate(signed);
    return r.ok ? { ok: true, intentsExecuted: r.intentsExecuted.length } : { ok: false, error: r.error };
  }

  async execute(signed: MultiPayload[]): Promise<ExecResult> {
    const r = this.model.execute(signed);
    this.height++;
    if (!r.ok) return { ok: false, txHash: null, blockHeight: this.height, blocksToExec: null, gasBurntTgas: null, error: r.error };
    this.txs++;
    return {
      ok: true,
      txHash: `model-${this.txs.toString().padStart(6, "0")}`,
      blockHeight: this.height,
      // K7: a non-self submitter's receipt executes one block after inclusion
      blocksToExec: 1,
      gasBurntTgas: gasTgasFor(signed.length),
    };
  }
}
