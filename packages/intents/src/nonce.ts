import { randomBytes } from 'node:crypto';
import { concat, hexdecode, hexencode, i64le, u8 } from './encoding.js';

/**
 * Versioned nonce (defuse core `nonce/versioned.rs`), 32 bytes:
 *   magic `5628f6c6` (4) ‖ borsh enum tag V1 = 0 (1) ‖ salt (4) ‖ deadline (Timestamp, i64 LE ns) (8) ‖ random (15)
 * Anything without the magic prefix (or failing to parse) is treated as a legacy nonce.
 */
export const VERSIONED_MAGIC = '5628f6c6';

export interface VersionedNonceV1 {
  salt: string; // 4 bytes hex
  deadlineNs: bigint;
  random: Uint8Array; // 15 bytes
}

export function buildNonce(saltHex: string, deadline: Date | bigint, random?: Uint8Array): Uint8Array {
  const salt = hexdecode(saltHex);
  if (salt.length !== 4) throw new Error(`salt must be 4 bytes hex, got '${saltHex}'`);
  const ns = typeof deadline === 'bigint' ? deadline : BigInt(deadline.getTime()) * 1_000_000n;
  const rnd = random ?? new Uint8Array(randomBytes(15));
  if (rnd.length !== 15) throw new Error('random part must be 15 bytes');
  return concat(hexdecode(VERSIONED_MAGIC), u8(0), salt, i64le(ns), rnd);
}

/** Parse a 32-byte nonce. Returns null for legacy (non-versioned) nonces. */
export function parseNonce(nonce: Uint8Array): VersionedNonceV1 | null {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  if (hexencode(nonce.subarray(0, 4)) !== VERSIONED_MAGIC) return null;
  if (nonce[4] !== 0) return null; // unknown borsh variant -> deserialization fails -> legacy
  const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  return {
    salt: hexencode(nonce.subarray(5, 9)),
    deadlineNs: dv.getBigInt64(9, true),
    random: nonce.slice(17, 32),
  };
}
