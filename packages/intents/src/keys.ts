import { ed25519 } from '@noble/curves/ed25519';
import { b58decode, b58encode } from './encoding.js';

export interface KeyPair {
  /** 32-byte ed25519 seed. */
  seed: Uint8Array;
  /** 32-byte public key. */
  publicKey: Uint8Array;
  /** `ed25519:<base58 public key>` */
  publicKeyStr: string;
  /** `ed25519:<base58 seed||public key>` (near-cli format) */
  secretKeyStr: string;
}

/**
 * Parse a near-cli style secret key `ed25519:<base58>`. The base58 part may be the
 * 64-byte `seed || public key` form (near-cli) or a bare 32-byte seed.
 */
export function parseSecretKey(secretKey: string): KeyPair {
  const [curve, data] = secretKey.includes(':') ? secretKey.split(':', 2) : ['ed25519', secretKey];
  if (curve !== 'ed25519') throw new Error(`unsupported key type '${curve}'`);
  const raw = b58decode(data!);
  if (raw.length !== 64 && raw.length !== 32) throw new Error(`bad ed25519 secret key length ${raw.length}`);
  const seed = raw.slice(0, 32);
  return fromSeed(seed);
}

export function fromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const publicKey = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed);
  full.set(publicKey, 32);
  return {
    seed,
    publicKey,
    publicKeyStr: 'ed25519:' + b58encode(publicKey),
    secretKeyStr: 'ed25519:' + b58encode(full),
  };
}

export function randomKeyPair(): KeyPair {
  return fromSeed(ed25519.utils.randomPrivateKey());
}

export function parsePublicKey(publicKey: string): Uint8Array {
  const [curve, data] = publicKey.split(':', 2);
  if (curve !== 'ed25519' || !data) throw new Error(`unsupported public key '${publicKey}'`);
  const raw = b58decode(data);
  if (raw.length !== 32) throw new Error(`bad ed25519 public key length ${raw.length}`);
  return raw;
}

export const sign = (msg: Uint8Array, kp: KeyPair): Uint8Array => ed25519.sign(msg, kp.seed);
export const verify = (sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean => {
  try {
    return ed25519.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
};

/** Implicit account id of an ed25519 public key: 64 lowercase hex chars. */
export const implicitAccountId = (publicKey: Uint8Array): string => Buffer.from(publicKey).toString('hex');
