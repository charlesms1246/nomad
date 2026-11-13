// LiveChain: the matcher's Chain on our testnet Verifier, through @nomad/intents.
import { IntentsClient, signTokenDiff, type Signer } from "@nomad/intents";
import type { MultiPayload, TokenId } from "@nomad/agent";
import type { Chain, DiffSigner, ExecResult, SimResult } from "./chain.js";

export class LiveChain implements Chain {
  readonly network = "testnet" as const;
  readonly client: IntentsClient;
  private feeCache?: { v: number; at: number };

  constructor(
    opts: { rpcUrl?: string; verifierId: string },
    private submitter: Signer,
  ) {
    this.client = new IntentsClient({ rpcUrl: opts.rpcUrl, verifierId: opts.verifierId });
  }

  get verifierId() {
    return this.client.verifierId;
  }

  async feePips() {
    if (!this.feeCache || Date.now() - this.feeCache.at > 60_000) this.feeCache = { v: await this.client.fee(), at: Date.now() };
    return this.feeCache.v;
  }

  salt() {
    return this.client.currentSalt();
  }

  async balances(account: string, tokens: TokenId[]) {
    if (tokens.length === 0) return {};
    const v = await this.client.mtBatchBalanceOf(account, tokens);
    return Object.fromEntries(tokens.map((t, i) => [t, v[i] ?? 0n]));
  }

  async simulate(signed: MultiPayload[]): Promise<SimResult> {
    const r = await this.client.simulate(signed as never);
    return { ok: r.ok, error: r.errorClass ? `${r.errorClass}: ${r.error ?? ""}` : r.error, intentsExecuted: r.intentsExecuted?.length };
  }

  async execute(signed: MultiPayload[], submitter: string): Promise<ExecResult> {
    if (submitter !== this.submitter.signerId) throw new Error(`LiveChain holds the key of ${this.submitter.signerId}, not ${submitter}`);
    try {
      const r = await this.client.execute(signed as never, this.submitter);
      const execHeight = r.receiptBlockHeights[0];
      return {
        ok: r.ok,
        txHash: r.txHash,
        blockHeight: r.blockHeight,
        blocksToExec: execHeight !== undefined ? execHeight - r.blockHeight : null,
        gasBurntTgas: Math.round((Number(r.gasBurnt) / 1e12) * 100) / 100,
        error: r.error,
      };
    } catch (e) {
      return { ok: false, txHash: null, blockHeight: null, blocksToExec: null, gasBurntTgas: null, error: String(e) };
    }
  }
}

/** Signs token_diffs for one account with its Verifier key. */
export const liveSigner =
  (signer: Signer): DiffSigner =>
  (a) =>
    signTokenDiff({
      signerId: signer.signerId,
      secretKey: signer.secretKey,
      verifierId: a.verifierId,
      salt: a.salt,
      deadline: a.deadline,
      diff: a.diff,
      memo: a.memo,
      nonce: a.nonce,
    }) as unknown as MultiPayload;
