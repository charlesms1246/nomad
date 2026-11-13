// A TypeScript model of the NEAR Intents Verifier (defuse 0.4.5, near/intents 16d04f6) for the
// intents Nomad uses: `token_diff` and `transfer`. It follows defuse-core `engine/mod.rs` step by
// step so the accept/reject outcome AND the error string match `simulate_intents`:
//
//   for each signed payload, in order:
//     1. signature            -> "invalid signature"
//     2. parse message JSON   -> "JSON: ..."
//     3. recipient == verifier-> "wrong verifying_contract"
//     4. deadline >= now      -> "deadline has expired"
//     5. key registered       -> "public key '..' doesn't exist for account '..'"
//     6. versioned nonce: salt valid -> "invalid salt"; msg deadline <= nonce deadline ->
//        "deadline is greater than nonce"; nonce deadline >= now -> "nonce was already expired"
//     7. nonce unused         -> "nonce was already used"
//     8. intents in order. token_diff: empty or a zero delta -> "invalid intent"; deltas applied
//        per token (sorted by token id) to the signer's balance, a negative balance ->
//        "insufficient balance or overflow"; fee = ceil(|d|·fee/1e6) on each negative delta,
//        credited to the fee collector. transfer: receiver == sender or no tokens -> "invalid intent".
//   finally: per token, Σ of every balance change (fees included) must be 0, else the batch is
//   rejected with "invariant violated" and the non-zero sums as `unmatched_deltas`.
import {
  b64decode,
  feeOf,
  implicitAccountId,
  intentHash,
  parseNonce,
  parsePublicKey,
  verifyPayload,
  type MultiPayload,
} from '@nomad/intents';

export type Balances = Map<string, Map<string, bigint>>;

export interface ModelConfig {
  verifierId: string;
  feePips: number;
  feeCollector: string;
  /** Salts that `is_valid_salt` accepts (hex). */
  validSalts: string[];
  /** Clock used for deadline checks. */
  now?: () => Date;
}

export interface ModelResult {
  ok: boolean;
  error?: string;
  /** Same classes as `@nomad/intents` errorClassOf. */
  errorClass?: string;
  /** Index of the signed payload that failed (not set for invariant violations). */
  failedAt?: number;
  intentsExecuted: { intent_hash: string; account_id: string; nonce: string }[];
  invariantViolated?: { error: 'unmatched_deltas'; unmatched_deltas: Record<string, string> };
  feesCollected: Record<string, bigint>;
  /** Per-account, per-token net balance changes of the batch. */
  deltas: Record<string, Record<string, bigint>>;
}

class Reject extends Error {
  constructor(readonly error: string, readonly errorClass: string) {
    super(error);
  }
}

function cloneBalances(b: Balances): Balances {
  return new Map([...b].map(([a, m]) => [a, new Map(m)]));
}

export class VerifierModel {
  balances: Balances = new Map();
  publicKeys = new Map<string, Set<string>>();
  usedNonces = new Map<string, Set<string>>();
  validSalts: Set<string>;

  constructor(readonly cfg: ModelConfig) {
    this.validSalts = new Set(cfg.validSalts);
  }

  private now(): Date {
    return this.cfg.now ? this.cfg.now() : new Date();
  }

  balanceOf(account: string, token: string): bigint {
    return this.balances.get(account)?.get(token) ?? 0n;
  }

  deposit(account: string, token: string, amount: bigint) {
    const m = this.balances.get(account) ?? new Map<string, bigint>();
    m.set(token, (m.get(token) ?? 0n) + amount);
    this.balances.set(account, m);
  }

  addPublicKey(account: string, publicKey: string) {
    const s = this.publicKeys.get(account) ?? new Set<string>();
    s.add(publicKey);
    this.publicKeys.set(account, s);
  }

  hasPublicKey(account: string, publicKey: string): boolean {
    if (this.publicKeys.get(account)?.has(publicKey)) return true;
    try {
      return /^[0-9a-f]{64}$/.test(account) && implicitAccountId(parsePublicKey(publicKey)) === account;
    } catch {
      return false;
    }
  }

  /** Run the batch without changing state (like `simulate_intents`). */
  simulate(signed: MultiPayload[]): ModelResult {
    return this.run(signed, false);
  }

  /** Run the batch and commit it if it succeeds (like `execute_intents`: all or nothing). */
  execute(signed: MultiPayload[]): ModelResult {
    return this.run(signed, true);
  }

  private run(signed: MultiPayload[], commit: boolean): ModelResult {
    const balances = cloneBalances(this.balances);
    const used = new Map([...this.usedNonces].map(([a, s]) => [a, new Set(s)]));
    const net = new Map<string, bigint>(); // per-token Σ of balance changes
    const deltas: Record<string, Record<string, bigint>> = {};
    const feesCollected: Record<string, bigint> = {};
    const executed: ModelResult['intentsExecuted'] = [];
    const now = this.now();

    const change = (account: string, token: string, d: bigint) => {
      const m = balances.get(account) ?? new Map<string, bigint>();
      const nb = (m.get(token) ?? 0n) + d;
      if (nb < 0n) throw new Reject('insufficient balance or overflow', 'insufficient balance or overflow');
      m.set(token, nb);
      balances.set(account, m);
      net.set(token, (net.get(token) ?? 0n) + d);
      (deltas[account] ??= {})[token] = ((deltas[account] ??= {})[token] ?? 0n) + d;
    };

    let i = 0;
    try {
      for (; i < signed.length; i++) {
        const mp = signed[i]!;
        if (!verifyPayload(mp)) throw new Reject('invalid signature', 'invalid signature');
        let msg: { signer_id: string; deadline: string; intents?: any[] };
        try {
          msg = JSON.parse(mp.payload.message);
          if (typeof msg.signer_id !== 'string' || typeof msg.deadline !== 'string') throw new Error('missing field');
        } catch (e: any) {
          throw new Reject('JSON: ' + e.message, 'JSON');
        }
        if (mp.payload.recipient !== this.cfg.verifierId) throw new Reject('wrong verifying_contract', 'wrong verifying_contract');
        const deadline = new Date(msg.deadline);
        if (Number.isNaN(deadline.getTime())) throw new Reject('JSON: bad deadline', 'JSON');
        if (deadline < now) throw new Reject('deadline has expired', 'deadline has expired');
        if (!this.hasPublicKey(msg.signer_id, mp.public_key))
          throw new Reject(`public key '${mp.public_key}' doesn't exist for account '${msg.signer_id}'`, 'public key not registered');

        const nonce = b64decode(mp.payload.nonce);
        const v = parseNonce(nonce);
        if (v) {
          if (!this.validSalts.has(v.salt)) throw new Reject('invalid salt', 'invalid salt');
          if (BigInt(deadline.getTime()) * 1_000_000n > v.deadlineNs) throw new Reject('deadline is greater than nonce', 'deadline is greater than nonce');
          if (v.deadlineNs < BigInt(now.getTime()) * 1_000_000n) throw new Reject('nonce was already expired', 'nonce was already expired');
        }
        const set = used.get(msg.signer_id) ?? new Set<string>();
        if (set.has(mp.payload.nonce)) throw new Reject('nonce was already used', 'nonce was already used');
        set.add(mp.payload.nonce);
        used.set(msg.signer_id, set);

        for (const intent of msg.intents ?? []) {
          if (intent.intent === 'token_diff') {
            const entries = Object.entries((intent.diff ?? {}) as Record<string, string>)
              .map(([t, s]) => [t, BigInt(s)] as const)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            if (entries.length === 0) throw new Reject('invalid intent', 'invalid intent');
            const fees: Record<string, bigint> = {};
            for (const [t, d] of entries) {
              if (d === 0n) throw new Reject('invalid intent', 'invalid intent');
              change(msg.signer_id, t, d);
              if (d < 0n) fees[t] = (fees[t] ?? 0n) + feeOf(d, this.cfg.feePips);
            }
            for (const [t, f] of Object.entries(fees)) {
              if (f === 0n) continue;
              change(this.cfg.feeCollector, t, f);
              feesCollected[t] = (feesCollected[t] ?? 0n) + f;
            }
          } else if (intent.intent === 'transfer') {
            const toks = Object.entries((intent.tokens ?? {}) as Record<string, string>).map(([t, s]) => [t, BigInt(s)] as const);
            if (intent.receiver_id === msg.signer_id || toks.length === 0) throw new Reject('invalid intent', 'invalid intent');
            for (const [t, a] of toks) change(msg.signer_id, t, -a);
            for (const [t, a] of toks) change(intent.receiver_id, t, a);
          } else {
            throw new Reject(`model: unsupported intent '${intent.intent}'`, 'other');
          }
        }
        executed.push({ intent_hash: intentHash(mp), account_id: msg.signer_id, nonce: mp.payload.nonce });
      }
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      return { ok: false, error: e.error, errorClass: e.errorClass, failedAt: i, intentsExecuted: executed, feesCollected, deltas };
    }

    const unmatched = Object.fromEntries([...net].filter(([, v]) => v !== 0n).map(([t, v]) => [t, v.toString()]));
    if (Object.keys(unmatched).length) {
      return {
        ok: false,
        error: 'invariant violated: ' + JSON.stringify({ error: 'unmatched_deltas', unmatched_deltas: unmatched }),
        errorClass: 'invariant violated',
        intentsExecuted: executed,
        invariantViolated: { error: 'unmatched_deltas', unmatched_deltas: unmatched },
        feesCollected,
        deltas,
      };
    }
    if (commit) {
      this.balances = balances;
      this.usedNonces = used;
    }
    return { ok: true, intentsExecuted: executed, feesCollected, deltas };
  }
}
