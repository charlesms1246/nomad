// Non-NEP-413 wallet standards accepted by the Verifier's `MultiPayload` (near/intents
// contracts/defuse/core/src/payload/{multi,erc191,raw}.rs at 16d04f6/dbad9c8):
//
//   erc191      {standard, payload: <JSON string>, signature: "secp256k1:<base58 r‖s‖v>"}
//               hash = keccak256("\x19Ethereum Signed Message:\n" ‖ len(payload) ‖ payload)  (personal_sign)
//               v is the recovery id, normalised to {0,1}; the public key is recovered from the signature.
//   raw_ed25519 {standard, payload: <JSON string>, public_key: "ed25519:…", signature: "ed25519:…"}
//               ed25519 over the payload bytes themselves (Phantom/Solana-style signMessage).
//
// For both, the payload is DefusePayload JSON: {signer_id, verifying_contract, deadline, nonce, ...intents}.
// signer_id is the implicit account of the key (core/src/public_key.rs `to_implicit_account_id`):
//   secp256k1: "0x" + hex(keccak256(uncompressed pubkey without 0x04)[12..32]) (lowercase)
//   ed25519:   hex(pubkey)
// Implicit accounts need no add_public_key on the Verifier.

import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { b58decode, b58encode, b64encode, concat, hexencode, utf8 } from './encoding.js';
import { buildNonce } from './nonce.js';
import type { Intent, MultiPayload, TokenDiffIntent, TokenId } from './nep413.js';

export interface SignedErc191Payload {
  standard: 'erc191';
  payload: string;
  signature: string; // "secp256k1:<base58 of 65 bytes>"
}

export interface SignedRawEd25519Payload {
  standard: 'raw_ed25519';
  payload: string;
  public_key: string; // "ed25519:<base58>"
  signature: string; // "ed25519:<base58>"
}

/** Any payload Nomad can put in one `execute_intents` batch. */
export type AnyMultiPayload = MultiPayload | SignedErc191Payload | SignedRawEd25519Payload;

/* ---------- keys and implicit accounts ---------- */

/** 64-byte uncompressed secp256k1 public key (no 0x04 prefix), as the Verifier stores it. */
export function secp256k1PublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, false).subarray(1);
}

/** Ethereum-style implicit account id: lowercase 0x address. */
export function ethImplicitAccountId(uncompressedPublicKey64: Uint8Array): string {
  if (uncompressedPublicKey64.length !== 64) throw new Error('expected a 64-byte uncompressed secp256k1 public key');
  return '0x' + hexencode(keccak_256(uncompressedPublicKey64).subarray(12));
}

export const ethAddressOf = (privateKey: Uint8Array): string => ethImplicitAccountId(secp256k1PublicKey(privateKey));

/* ---------- payload ---------- */

export interface DefusePayloadArgs {
  signerId: string;
  verifierId: string;
  deadline: Date;
  /** current salt, 4 bytes hex. Ignored if `nonce` is given. */
  salt: string;
  intents: Intent[];
  /** Override the 32-byte nonce (golden vectors). Defaults to a fresh versioned nonce. */
  nonce?: Uint8Array;
}

/** The DefusePayload JSON string: {signer_id, verifying_contract, deadline, nonce, intents}. */
export function buildDefusePayload(a: DefusePayloadArgs): string {
  const nonce = a.nonce ?? buildNonce(a.salt, a.deadline);
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  return JSON.stringify({
    signer_id: a.signerId,
    verifying_contract: a.verifierId,
    deadline: a.deadline.toISOString(),
    nonce: b64encode(nonce),
    intents: a.intents,
  });
}

function tokenDiffIntent(diff: Record<TokenId, string>, memo?: string): TokenDiffIntent {
  for (const [t, v] of Object.entries(diff)) {
    if (!/^-?[0-9]+$/.test(v)) throw new Error(`diff[${t}] must be an integer string, got '${v}'`);
    if (BigInt(v) === 0n) throw new Error(`diff[${t}] is zero (the Verifier rejects it as invalid intent)`);
  }
  const intent: TokenDiffIntent = { intent: 'token_diff', diff };
  if (memo !== undefined) intent.memo = memo;
  return intent;
}

/* ---------- ERC-191 (personal_sign) ---------- */

/** keccak256("\x19Ethereum Signed Message:\n" ‖ decimal byte length ‖ msg), as `Erc191::prehash`. */
export function erc191Hash(message: string): Uint8Array {
  const msg = utf8(message);
  return keccak_256(concat(utf8('\x19Ethereum Signed Message:\n'), utf8(String(msg.length)), msg));
}

/** Sign any string with personal_sign semantics. Returns 65 bytes r‖s‖v with v ∈ {0,1}. */
export function erc191Sign(message: string, privateKey: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(erc191Hash(message), privateKey, { lowS: true });
  return concat(sig.toCompactRawBytes(), new Uint8Array([sig.recovery!]));
}

/**
 * Normalise a wallet's 65-byte signature: v may come back as 27/28 (or 0/1); the Verifier wants 0/1.
 */
export function normaliseErc191Signature(sig65: Uint8Array): Uint8Array {
  if (sig65.length !== 65) throw new Error('expected a 65-byte signature');
  const out = sig65.slice();
  if (out[64] >= 27) out[64] -= 27;
  if (out[64] > 1) throw new Error(`bad recovery id ${sig65[64]}`);
  return out;
}

/** Recover the 64-byte public key from an erc191 signature (local check, mirrors `Erc191::recover`). */
export function erc191Recover(message: string, sig65: Uint8Array): Uint8Array {
  const s = normaliseErc191Signature(sig65);
  const sig = secp256k1.Signature.fromCompact(s.subarray(0, 64)).addRecoveryBit(s[64]);
  return sig.recoverPublicKey(erc191Hash(message)).toRawBytes(false).subarray(1);
}

export interface SignErc191TokenDiffArgs {
  /** 32-byte secp256k1 private key. */
  privateKey: Uint8Array;
  verifierId: string;
  salt: string;
  deadline: Date;
  diff: Record<TokenId, string>;
  memo?: string;
  nonce?: Uint8Array;
}

export function signErc191Intents(a: Omit<SignErc191TokenDiffArgs, 'diff' | 'memo'> & { intents: Intent[] }): SignedErc191Payload {
  const payload = buildDefusePayload({ signerId: ethAddressOf(a.privateKey), verifierId: a.verifierId, deadline: a.deadline, salt: a.salt, intents: a.intents, nonce: a.nonce });
  return { standard: 'erc191', payload, signature: 'secp256k1:' + b58encode(erc191Sign(payload, a.privateKey)) };
}

/** One `token_diff`, signed as an Ethereum wallet would (personal_sign). signer_id = lowercase 0x address. */
export function signErc191TokenDiff(a: SignErc191TokenDiffArgs): SignedErc191Payload {
  return signErc191Intents({ ...a, intents: [tokenDiffIntent(a.diff, a.memo)] });
}

/* ---------- raw ed25519 (Solana / Phantom signMessage) ---------- */

export interface SignRawEd25519TokenDiffArgs {
  /** 32-byte ed25519 seed. */
  seed: Uint8Array;
  verifierId: string;
  salt: string;
  deadline: Date;
  diff: Record<TokenId, string>;
  memo?: string;
  nonce?: Uint8Array;
}

/** Implicit account of an ed25519 key: hex of the public key. */
export const rawEd25519AccountId = (seed: Uint8Array): string => hexencode(ed25519.getPublicKey(seed));

export function signRawEd25519Intents(a: Omit<SignRawEd25519TokenDiffArgs, 'diff' | 'memo'> & { intents: Intent[] }): SignedRawEd25519Payload {
  const pk = ed25519.getPublicKey(a.seed);
  const payload = buildDefusePayload({ signerId: hexencode(pk), verifierId: a.verifierId, deadline: a.deadline, salt: a.salt, intents: a.intents, nonce: a.nonce });
  const sig = ed25519.sign(utf8(payload), a.seed);
  return { standard: 'raw_ed25519', payload, public_key: 'ed25519:' + b58encode(pk), signature: 'ed25519:' + b58encode(sig) };
}

/** One `token_diff`, signed over the raw payload bytes. signer_id = hex(ed25519 public key). */
export function signRawEd25519TokenDiff(a: SignRawEd25519TokenDiffArgs): SignedRawEd25519Payload {
  return signRawEd25519Intents({ ...a, intents: [tokenDiffIntent(a.diff, a.memo)] });
}

/* ---------- verification and hashes ---------- */

/** Local signature check; also checks that signer_id is the key's implicit account. */
export function verifyAnyPayload(mp: AnyMultiPayload): boolean {
  try {
    if (mp.standard === 'erc191') {
      const sig = b58decode(mp.signature.replace(/^secp256k1:/, ''));
      const pk = erc191Recover(mp.payload, sig);
      return JSON.parse(mp.payload).signer_id === ethImplicitAccountId(pk);
    }
    if (mp.standard === 'raw_ed25519') {
      const pk = b58decode(mp.public_key.replace(/^ed25519:/, ''));
      const ok = ed25519.verify(b58decode(mp.signature.replace(/^ed25519:/, '')), utf8(mp.payload), pk);
      return ok && JSON.parse(mp.payload).signer_id === hexencode(pk);
    }
    return false;
  } catch {
    return false;
  }
}

/** Intent hash as the Verifier logs it (`Payload::hash`), base58. */
export function anyIntentHash(mp: SignedErc191Payload | SignedRawEd25519Payload): string {
  return b58encode(mp.standard === 'erc191' ? erc191Hash(mp.payload) : sha256(utf8(mp.payload)));
}
