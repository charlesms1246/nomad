import { b58encode, b64encode } from './encoding.js';
import { parseSecretKey, type KeyPair } from './keys.js';
import { signTransaction, type Action } from './tx.js';

export const TESTNET_RPC = 'https://rpc.testnet.fastnear.com';
export const MAINNET_RPC = 'https://rpc.mainnet.fastnear.com';
/** Public testnet endpoints that responded on 2026-11-14, used as fallbacks. */
export const TESTNET_RPC_FALLBACKS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'];

export class RpcError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
  }
}

export interface TxOutcome {
  txHash: string;
  ok: boolean;
  error?: string;
  /** Total gas burnt by the tx and all its receipts. */
  gasBurnt: string;
  /** Height of the block that included the transaction. */
  blockHeight: number;
  /** Block hash including the transaction. */
  blockHash: string;
  /** Heights of the blocks in which each receipt executed (first = the tx's function call). */
  receiptBlockHeights: number[];
  /** Decoded base64 SuccessValue of the last receipt, if any. */
  returnValue?: string;
  logs: string[];
  raw: any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract a readable error from a NEAR execution status / RPC error. */
export function describeFailure(f: any): string {
  const exec = f?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (typeof exec === 'string') return exec;
  return JSON.stringify(f);
}

export class NearRpc {
  private nonces = new Map<string, bigint>();
  private blockHeights = new Map<string, number>();

  private urls: string[];
  private cur = 0;

  /**
   * @param url primary RPC endpoint
   * @param fallbacks endpoints to rotate to on HTTP 429/5xx or network errors
   *   (env NEAR_RPC_FALLBACKS, comma-separated, is appended)
   */
  constructor(readonly url: string = TESTNET_RPC, fallbacks: string[] = []) {
    const env = (globalThis.process?.env?.NEAR_RPC_FALLBACKS ?? '').split(',').filter(Boolean);
    this.urls = [...new Set([url, ...fallbacks, ...env])];
  }

  async call<T = any>(method: string, params: unknown, retries = 6): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetch(this.urls[this.cur % this.urls.length]!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'nomad', method, params }),
        });
        if (r.status === 429 || r.status >= 500) throw new RpcError(`HTTP ${r.status}`);
        const j: any = await r.json();
        if (j.error) {
          const name = j.error?.cause?.name ?? j.error?.name;
          // transient
          if (name === 'TIMEOUT_ERROR' || name === 'INTERNAL_ERROR') throw new RpcError(JSON.stringify(j.error), j.error);
          const e = new RpcError(JSON.stringify(j.error), j.error);
          (e as any).fatal = true;
          throw e;
        }
        return j.result as T;
      } catch (e: any) {
        lastErr = e;
        if (e?.fatal) throw e;
        if (this.urls.length > 1 && /HTTP|fetch failed/.test(String(e?.message))) {
          this.cur++; // rotate to the next endpoint; retry immediately once per endpoint
          if (i < this.urls.length - 1) continue;
        }
        await sleep(Math.min(8000, 300 * 2 ** i));
      }
    }
    throw lastErr;
  }

  /** View call; returns parsed JSON (or throws with the contract error string). */
  async view<T = any>(accountId: string, method: string, args: object = {}, finality: 'final' | 'optimistic' = 'optimistic'): Promise<T> {
    const res: any = await this.call('query', {
      request_type: 'call_function',
      finality,
      account_id: accountId,
      method_name: method,
      args_base64: b64encode(new TextEncoder().encode(JSON.stringify(args))),
    });
    if (res.error) throw new RpcError(res.error, res);
    const txt = Buffer.from(res.result).toString();
    return (txt.length ? JSON.parse(txt) : null) as T;
  }

  async viewAccount(accountId: string): Promise<{ amount: string; locked: string; code_hash: string; storage_usage: number } | null> {
    try {
      return await this.call('query', { request_type: 'view_account', finality: 'optimistic', account_id: accountId });
    } catch (e: any) {
      if (/UNKNOWN_ACCOUNT|does not exist/.test(e.message)) return null;
      throw e;
    }
  }

  async blockHeight(blockHash: string): Promise<number> {
    const c = this.blockHeights.get(blockHash);
    if (c !== undefined) return c;
    const b: any = await this.call('block', { block_id: blockHash });
    this.blockHeights.set(blockHash, b.header.height);
    return b.header.height;
  }

  /** Sign and send a transaction, wait for it to execute, and summarise the outcome. */
  async sendTx(
    signer: { signerId: string; secretKey: string | KeyPair },
    receiverId: string,
    actions: Action[],
    opts: { waitUntil?: 'INCLUDED_FINAL' | 'EXECUTED_OPTIMISTIC' | 'FINAL'; withHeights?: boolean } = {},
  ): Promise<TxOutcome> {
    const kp = typeof signer.secretKey === 'string' ? parseSecretKey(signer.secretKey) : signer.secretKey;
    const keyId = `${signer.signerId}:${kp.publicKeyStr}`;
    for (let attempt = 0; ; attempt++) {
      const ak: any = await this.call('query', {
        request_type: 'view_access_key',
        finality: 'optimistic',
        account_id: signer.signerId,
        public_key: kp.publicKeyStr,
      });
      const prev = this.nonces.get(keyId) ?? 0n;
      const nonce = (BigInt(ak.nonce) > prev ? BigInt(ak.nonce) : prev) + 1n;
      this.nonces.set(keyId, nonce);
      const { signed, hash } = signTransaction(
        { signerId: signer.signerId, publicKey: kp.publicKeyStr, nonce, receiverId, blockHash: ak.block_hash, actions },
        kp,
      );
      const txHash = b58encode(hash);
      let res: any;
      try {
        res = await this.call('send_tx', { signed_tx_base64: b64encode(signed), wait_until: opts.waitUntil ?? 'EXECUTED_OPTIMISTIC' }, 0);
      } catch (e: any) {
        const msg = String(e.message);
        if (attempt < 3 && /InvalidNonce|Expired/.test(msg)) continue;
        if (/TIMEOUT_ERROR|HTTP 5|HTTP 429|fetch failed/.test(msg)) {
          res = await this.waitTx(txHash, signer.signerId, 120_000, b64encode(signed));
        } else throw e;
      }
      return this.summarise(txHash, res, opts.withHeights ?? true);
    }
  }

  /**
   * Poll for a transaction's outcome. If `signedB64` is given, the same signed bytes are
   * re-broadcast (idempotent: same hash) whenever the RPC reports the tx as not observed.
   */
  async waitTx(txHash: string, senderId: string, timeoutMs = 60_000, signedB64?: string): Promise<any> {
    const t0 = Date.now();
    for (;;) {
      if (signedB64) await this.call('broadcast_tx_async', [signedB64], 0).catch(() => undefined);
      try {
        return await this.call('tx', { tx_hash: txHash, sender_account_id: senderId, wait_until: 'EXECUTED_OPTIMISTIC' }, 0);
      } catch (e) {
        if (Date.now() - t0 > timeoutMs) throw e;
        await sleep(1500);
      }
    }
  }

  async summarise(txHash: string, res: any, withHeights: boolean): Promise<TxOutcome> {
    const outcomes = [res.transaction_outcome, ...(res.receipts_outcome ?? [])];
    const gasBurnt = outcomes.reduce((s: bigint, o: any) => s + BigInt(o.outcome.gas_burnt), 0n);
    const logs = outcomes.flatMap((o: any) => o.outcome.logs as string[]);
    const status = res.status ?? {};
    let ok = 'SuccessValue' in status || 'SuccessReceiptId' in status;
    let error: string | undefined;
    if ('Failure' in status) {
      ok = false;
      error = describeFailure(status.Failure);
    }
    // Only the top-level status counts: e.g. a gas-refund receipt to a deleted account fails harmlessly.
    const rv = status.SuccessValue ? Buffer.from(status.SuccessValue, 'base64').toString() : undefined;
    const blockHash = res.transaction_outcome.block_hash as string;
    let blockHeight = -1;
    let receiptBlockHeights: number[] = [];
    if (withHeights) {
      blockHeight = await this.blockHeight(blockHash);
      receiptBlockHeights = await Promise.all((res.receipts_outcome ?? []).map((o: any) => this.blockHeight(o.block_hash)));
    }
    return { txHash, ok, error, gasBurnt: gasBurnt.toString(), blockHeight, blockHash, receiptBlockHeights, returnValue: rv, logs, raw: res };
  }
}
