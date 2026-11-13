import { NearRpc, RpcError, TESTNET_RPC, type TxOutcome } from './rpc.js';
import { ONE_YOCTO, TGAS } from './tx.js';
import type { MultiPayload } from './nep413.js';

export const DEFAULT_VERIFIER_ID = 'intents.nomadswarm.testnet';

export interface Signer {
  signerId: string;
  /** near-cli format `ed25519:<base58>` (a full-access or function-call key of `signerId`) */
  secretKey: string;
}

export interface SimulateResult {
  ok: boolean;
  intentsExecuted?: { intent_hash: string; account_id: string; nonce: string }[];
  logs?: string[];
  /** Raw panic string or invariant violation, when !ok. */
  error?: string;
  /** Short error class, e.g. `invalid signature`, `insufficient balance or overflow`, `invariant violated`. */
  errorClass?: string;
  invariantViolated?: unknown;
  minDeadline?: string;
  state?: { fee: number; current_salt: string };
  raw?: unknown;
}

export interface ExecuteResult {
  txHash: string;
  blockHeight: number;
  ok: boolean;
  error?: string;
  gasBurnt: string;
  /** Block heights where receipts executed (index 0 is the `execute_intents` receipt). */
  receiptBlockHeights: number[];
  logs: string[];
}

const KNOWN_ERRORS = [
  'invalid signature',
  'insufficient balance or overflow',
  'invalid salt',
  'invalid intent',
  'invalid nonce',
  'nonce was already used',
  'nonce was already expired',
  'deadline has expired',
  'deadline is greater than nonce',
  'wrong verifying_contract',
  'invariant violated',
  "doesn't exist for account",
  'is locked',
  'JSON',
];

/** Map a contract panic string onto a short, stable error class. */
export function errorClassOf(msg: string | undefined): string | undefined {
  if (!msg) return undefined;
  for (const k of KNOWN_ERRORS) if (msg.includes(k)) return k === "doesn't exist for account" ? 'public key not registered' : k;
  return 'other';
}

/** Pull the contract panic string out of an RPC view error. */
export function panicMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const x = m.match(/Smart contract panicked: (.*?)(?:\\*"|\\n|\n|$)/);
  if (x) return x[1]!;
  const y = m.match(/wasm execution failed with error: (.*)/);
  return y ? y[1]! : m;
}

export class IntentsClient {
  readonly rpc: NearRpc;
  readonly verifierId: string;
  private saltCache?: { salt: string; at: number };

  constructor(opts: { rpcUrl?: string; verifierId?: string; rpc?: NearRpc } = {}) {
    this.rpc = opts.rpc ?? new NearRpc(opts.rpcUrl ?? TESTNET_RPC);
    this.verifierId = opts.verifierId ?? DEFAULT_VERIFIER_ID;
  }

  /** `current_salt`, cached for up to `maxAgeMs` (default 60 s, TECH_DOC §6.4). */
  async currentSalt(maxAgeMs = 60_000): Promise<string> {
    if (this.saltCache && Date.now() - this.saltCache.at < maxAgeMs) return this.saltCache.salt;
    const salt = await this.rpc.view<string>(this.verifierId, 'current_salt');
    this.saltCache = { salt, at: Date.now() };
    return salt;
  }

  async isValidSalt(salt: string): Promise<boolean> {
    return this.rpc.view<boolean>(this.verifierId, 'is_valid_salt', { salt });
  }

  /** Fee in pips (1 pip = 1e-6). */
  async fee(): Promise<number> {
    return Number(await this.rpc.view(this.verifierId, 'fee'));
  }

  async feeCollector(): Promise<string> {
    return this.rpc.view<string>(this.verifierId, 'fee_collector');
  }

  async simulate(signed: MultiPayload[]): Promise<SimulateResult> {
    let out: any;
    try {
      out = await this.rpc.view(this.verifierId, 'simulate_intents', { signed });
    } catch (e) {
      // Only contract execution errors are rejections; transport errors (429, timeouts) are rethrown.
      if (!(e instanceof RpcError) || !/panicked|GuestPanic|wasm execution failed|FunctionCallError/.test(e.message)) throw e;
      const error = panicMessage(e);
      return { ok: false, error, errorClass: errorClassOf(error) };
    }
    const base = {
      intentsExecuted: out.intents_executed,
      logs: out.logs,
      minDeadline: out.min_deadline,
      state: out.state,
      raw: out,
    };
    if (out.invariant_violated) {
      return { ...base, ok: false, invariantViolated: out.invariant_violated, error: 'invariant violated: ' + JSON.stringify(out.invariant_violated), errorClass: 'invariant violated' };
    }
    return { ...base, ok: true };
  }

  /** Submit `execute_intents` (not payable; 300 Tgas, BUILD_PLAN C8). */
  async execute(signed: MultiPayload[], submitter: Signer, gas: bigint = 300n * TGAS): Promise<ExecuteResult> {
    const r = await this.rpc.sendTx(submitter, this.verifierId, [
      { type: 'FunctionCall', methodName: 'execute_intents', args: { signed }, gas, deposit: 0n },
    ]);
    return { txHash: r.txHash, blockHeight: r.blockHeight, ok: r.ok, error: r.error, gasBurnt: r.gasBurnt, receiptBlockHeights: r.receiptBlockHeights, logs: r.logs };
  }

  async mtBalanceOf(accountId: string, tokenId: string): Promise<bigint> {
    return BigInt(await this.rpc.view<string>(this.verifierId, 'mt_balance_of', { account_id: accountId, token_id: tokenId }));
  }

  async mtBatchBalanceOf(accountId: string, tokenIds: string[]): Promise<bigint[]> {
    const r = await this.rpc.view<string[]>(this.verifierId, 'mt_batch_balance_of', { account_id: accountId, token_ids: tokenIds });
    return r.map((x) => BigInt(x));
  }

  async hasPublicKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.rpc.view<boolean>(this.verifierId, 'has_public_key', { account_id: accountId, public_key: publicKey });
  }

  async publicKeysOf(accountId: string): Promise<string[]> {
    return this.rpc.view<string[]>(this.verifierId, 'public_keys_of', { account_id: accountId });
  }

  async isNonceUsed(accountId: string, nonceB64: string): Promise<boolean> {
    return this.rpc.view<boolean>(this.verifierId, 'is_nonce_used', { account_id: accountId, nonce: nonceB64 });
  }

  /** Register `publicKey` for the signing account on the Verifier (1 yocto, BUILD_PLAN C7). */
  async addPublicKey(account: Signer, publicKey: string): Promise<TxOutcome> {
    return this.rpc.sendTx(account, this.verifierId, [
      { type: 'FunctionCall', methodName: 'add_public_key', args: { public_key: publicKey }, gas: 10n * TGAS, deposit: ONE_YOCTO },
    ]);
  }

  /**
   * Deposit NEP-141 tokens into the Verifier: `ft_transfer_call` on the token, 1 yocto (BUILD_PLAN C6).
   * `receiverId` defaults to the sender (empty `msg`).
   */
  async deposit(from: Signer, tokenContract: string, amount: bigint, receiverId?: string): Promise<TxOutcome> {
    return this.rpc.sendTx(from, tokenContract, [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: this.verifierId, amount: amount.toString(), msg: receiverId && receiverId !== from.signerId ? receiverId : '' },
        gas: 100n * TGAS,
        deposit: ONE_YOCTO,
      },
    ]);
  }

  /** Wrap NEAR on a wNEAR contract (`near_deposit`). */
  async nearDeposit(from: Signer, wnearContract: string, amountYocto: bigint): Promise<TxOutcome> {
    return this.rpc.sendTx(from, wnearContract, [
      { type: 'FunctionCall', methodName: 'near_deposit', args: {}, gas: 10n * TGAS, deposit: amountYocto },
    ]);
  }

  /** NEP-145 storage_deposit on a token for `accountId` (default 0.00125 NEAR). */
  async storageDeposit(payer: Signer, tokenContract: string, accountId: string, amountYocto = 1_250_000_000_000_000_000_000n): Promise<TxOutcome> {
    return this.rpc.sendTx(payer, tokenContract, [
      { type: 'FunctionCall', methodName: 'storage_deposit', args: { account_id: accountId, registration_only: true }, gas: 10n * TGAS, deposit: amountYocto },
    ]);
  }

  async ftBalanceOf(tokenContract: string, accountId: string): Promise<bigint> {
    return BigInt(await this.rpc.view<string>(tokenContract, 'ft_balance_of', { account_id: accountId }));
  }
}
