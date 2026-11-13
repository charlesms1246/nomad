// What the matcher needs from "the chain". Two implementations:
//  - LiveChain: our testnet Verifier via @nomad/intents (execute_intents / simulate_intents).
//  - ModelChain: the local verifier model (@nomad/verifier-model) for `make sim`, no network.

import type { MultiPayload, TokenId } from "@nomad/agent";

export interface SimResult {
  ok: boolean;
  error?: string;
  intentsExecuted?: number;
}

export interface ExecResult {
  ok: boolean;
  txHash: string | null;
  blockHeight: number | null;
  /** Blocks from the tx's inclusion to the Verifier receipt executing (0 = same block). */
  blocksToExec: number | null;
  gasBurntTgas: number | null;
  error?: string;
}

export interface Chain {
  readonly verifierId: string;
  readonly network: "testnet" | "sim";
  feePips(): Promise<number>;
  salt(): Promise<string>;
  balances(account: string, tokens: TokenId[]): Promise<Record<TokenId, bigint>>;
  simulate(signed: MultiPayload[]): Promise<SimResult>;
  /** Submits one execute_intents from `submitter` (the matcher account). */
  execute(signed: MultiPayload[], submitter: string): Promise<ExecResult>;
}

/** Signs a token_diff as some account (matcher's own leg). */
export type DiffSigner = (args: {
  diff: Record<TokenId, string>;
  deadline: Date;
  salt: string;
  verifierId: string;
  memo?: string;
  nonce?: Uint8Array;
}) => MultiPayload;
