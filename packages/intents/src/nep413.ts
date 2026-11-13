import { sha256 } from '@noble/hashes/sha256';
import { b58decode, b58encode, b64decode, b64encode, borshString, concat, u32le, u8 } from './encoding.js';
import { parsePublicKey, parseSecretKey, sign, verify } from './keys.js';
import { buildNonce } from './nonce.js';

export type TokenId = string;

export interface TokenDiffIntent {
  intent: 'token_diff';
  diff: Record<TokenId, string>;
  memo?: string;
  referral?: string;
}
export interface TransferIntent {
  intent: 'transfer';
  receiver_id: string;
  tokens: Record<TokenId, string>;
  memo?: string;
}
export interface AddPublicKeyIntent {
  intent: 'add_public_key';
  public_key: string;
}
export type Intent = TokenDiffIntent | TransferIntent | AddPublicKeyIntent | ({ intent: string } & Record<string, unknown>);

export interface Nep413Payload {
  message: string;
  nonce: string; // base64, 32 bytes
  recipient: string;
  callback_url?: string;
}

/** The NEP-413 variant of the Verifier's `MultiPayload` (the only one Nomad produces). */
export interface MultiPayload {
  standard: 'nep413';
  payload: Nep413Payload;
  public_key: string;
  signature: string;
}

/** NEP-413 tag: 2^31 + 413, u32 LE. */
export const NEP413_TAG = 2 ** 31 + 413;

/**
 * NEP-413 hash: sha256( u32_le(2^31+413) ‖ borsh(message) ‖ nonce[32] ‖ borsh(recipient) ‖ borsh(Option<callback_url>) ).
 */
export function nep413Hash(p: Nep413Payload): Uint8Array {
  const nonce = b64decode(p.nonce);
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const cb = p.callback_url == null ? u8(0) : concat(u8(1), borshString(p.callback_url));
  return sha256(concat(u32le(NEP413_TAG), borshString(p.message), nonce, borshString(p.recipient), cb));
}

export interface SignIntentsArgs {
  signerId: string;
  /** near-cli format `ed25519:<base58>` */
  secretKey: string;
  verifierId: string;
  /** current salt, 4 bytes hex (from `current_salt`) */
  salt: string;
  deadline: Date;
  intents: Intent[];
  /** Override the 32-byte nonce (tests/golden vectors). Defaults to a fresh versioned nonce. */
  nonce?: Uint8Array;
}

/** Build the one-line JSON message `{signer_id, deadline, intents}` (BUILD_PLAN C2). */
export function buildMessage(signerId: string, deadline: Date, intents: Intent[]): string {
  return JSON.stringify({ signer_id: signerId, deadline: deadline.toISOString(), intents });
}

export function signIntents(a: SignIntentsArgs): MultiPayload {
  const kp = parseSecretKey(a.secretKey);
  const nonce = a.nonce ?? buildNonce(a.salt, a.deadline);
  const payload: Nep413Payload = {
    message: buildMessage(a.signerId, a.deadline, a.intents),
    nonce: b64encode(nonce),
    recipient: a.verifierId,
  };
  const sig = sign(nep413Hash(payload), kp);
  return { standard: 'nep413', payload, public_key: kp.publicKeyStr, signature: 'ed25519:' + b58encode(sig) };
}

export interface SignTokenDiffArgs extends Omit<SignIntentsArgs, 'intents'> {
  diff: Record<TokenId, string>;
  memo?: string;
  referral?: string;
}

/** Sign one `token_diff` intent. Diff values are signed decimal strings ("-1000", "999"). */
export function signTokenDiff(a: SignTokenDiffArgs): MultiPayload {
  for (const [t, v] of Object.entries(a.diff)) {
    if (!/^-?[0-9]+$/.test(v)) throw new Error(`diff[${t}] must be an integer string, got '${v}'`);
    if (BigInt(v) === 0n) throw new Error(`diff[${t}] is zero (the Verifier rejects it as invalid intent)`);
  }
  const intent: TokenDiffIntent = { intent: 'token_diff', diff: a.diff };
  if (a.memo !== undefined) intent.memo = a.memo;
  if (a.referral !== undefined) intent.referral = a.referral;
  return signIntents({ ...a, intents: [intent] });
}

/** Verify a MultiPayload's signature locally. */
export function verifyPayload(mp: MultiPayload): boolean {
  if (mp.standard !== 'nep413') return false;
  if (!mp.signature.startsWith('ed25519:')) return false;
  try {
    const sig = b58decode(mp.signature.slice('ed25519:'.length));
    if (sig.length !== 64) return false;
    return verify(sig, nep413Hash(mp.payload), parsePublicKey(mp.public_key));
  } catch {
    return false;
  }
}

/** Intent hash as the Verifier reports it (the NEP-413 hash), base58. */
export const intentHash = (mp: MultiPayload): string => b58encode(nep413Hash(mp.payload));
