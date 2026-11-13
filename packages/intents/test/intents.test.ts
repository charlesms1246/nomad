import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  b58decode,
  b58encode,
  buildNonce,
  closureDeltas,
  feeOf,
  fromSeed,
  grossForNet,
  intentHash,
  nep413Hash,
  netOfFee,
  parseNonce,
  parseSecretKey,
  signTokenDiff,
  verifyPayload,
  errorClassOf,
  panicMessage,
} from '../src/index.js';

// Fixed inputs for golden vectors.
const SEED = new Uint8Array(32).map((_, i) => i + 1);
const KP = fromSeed(SEED);
const NONCE_RANDOM = new Uint8Array(15).fill(7);
const DEADLINE = new Date('2026-11-14T12:00:00.000Z');
const SALT = '252812b3';
const VERIFIER = 'intents.nomadswarm.testnet';
const W = 'nep141:wnear.nomadswarm.testnet';
const U = 'nep141:usdc.nomadswarm.testnet';

// Independent reference: the algorithm from docs/spec/supplementary/probes/scripts/simulate-ring.mjs
// (verified against mainnet simulate_intents), using node:crypto only.
function referenceSign(seed: Uint8Array, signerId: string, message: string, nonce: Uint8Array, recipient: string) {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const bstr = (s: string) => {
    const x = Buffer.from(s, 'utf8');
    return Buffer.concat([u32(x.length), x]);
  };
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const payload = Buffer.concat([bstr(message), Buffer.from(nonce), bstr(recipient), Buffer.from([0])]);
  const hash = crypto.createHash('sha256').update(Buffer.concat([u32(2 ** 31 + 413), payload])).digest();
  return { hash, sig: crypto.sign(null, hash, key) };
}

describe('encoding', () => {
  it('base58 round-trips, including leading zeros', () => {
    for (const b of [new Uint8Array([0, 0, 1, 2, 3]), crypto.randomBytes(32), new Uint8Array(32)]) {
      expect(b58decode(b58encode(b))).toEqual(new Uint8Array(b));
    }
  });
  it('parses near-cli 64-byte secret keys and bare seeds identically', () => {
    const a = parseSecretKey(KP.secretKeyStr);
    const b = parseSecretKey('ed25519:' + b58encode(SEED));
    expect(a.publicKeyStr).toBe(KP.publicKeyStr);
    expect(b.publicKeyStr).toBe(KP.publicKeyStr);
  });
});

describe('versioned nonce', () => {
  it('lays out magic ‖ 0 ‖ salt ‖ deadline i64 LE ns ‖ random(15)', () => {
    const n = buildNonce(SALT, DEADLINE, NONCE_RANDOM);
    expect(n.length).toBe(32);
    expect(Buffer.from(n).toString('hex')).toBe(
      '5628f6c6' + '00' + SALT + Buffer.from(new BigInt64Array([BigInt(DEADLINE.getTime()) * 1_000_000n]).buffer).toString('hex') + '07'.repeat(15),
    );
    const p = parseNonce(n)!;
    expect(p.salt).toBe(SALT);
    expect(p.deadlineNs).toBe(BigInt(DEADLINE.getTime()) * 1_000_000n);
  });
  it('treats non-magic and unknown versions as legacy', () => {
    expect(parseNonce(new Uint8Array(32))).toBeNull();
    const n = buildNonce(SALT, DEADLINE, NONCE_RANDOM);
    n[4] = 9;
    expect(parseNonce(n)).toBeNull();
  });
});

describe('NEP-413 token_diff signer (golden vectors)', () => {
  const nonce = buildNonce(SALT, DEADLINE, NONCE_RANDOM);
  const mp = signTokenDiff({
    signerId: 'a01.nomadswarm.testnet',
    secretKey: KP.secretKeyStr,
    verifierId: VERIFIER,
    salt: SALT,
    deadline: DEADLINE,
    diff: { [W]: '-1000', [U]: '999' },
    nonce,
  });

  it('produces the expected message and payload', () => {
    expect(mp.payload.message).toBe(
      '{"signer_id":"a01.nomadswarm.testnet","deadline":"2026-11-14T12:00:00.000Z","intents":[{"intent":"token_diff","diff":{"nep141:wnear.nomadswarm.testnet":"-1000","nep141:usdc.nomadswarm.testnet":"999"}}]}',
    );
    expect(mp.payload.recipient).toBe(VERIFIER);
    expect(mp.payload.nonce).toBe(Buffer.from(nonce).toString('base64'));
    expect(mp.public_key).toBe(KP.publicKeyStr);
  });

  it('matches the independent node:crypto reference byte for byte', () => {
    const ref = referenceSign(SEED, 'a01.nomadswarm.testnet', mp.payload.message, nonce, VERIFIER);
    expect(Buffer.from(nep413Hash(mp.payload)).toString('hex')).toBe(ref.hash.toString('hex'));
    expect(mp.signature).toBe('ed25519:' + b58encode(ref.sig));
  });

  it('is pinned (golden)', () => {
    expect({ pk: mp.public_key, hash: intentHash(mp), sig: mp.signature }).toMatchInlineSnapshot(`
      {
        "hash": "DgqcXHgxPUxBmG7wodpomdX7JYv9fra8C1PseYSHwAuT",
        "pk": "ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
        "sig": "ed25519:33xiUKETMrmiaZrTsPfXUgXcbQDWT9f6qtrP2xCBbAub4hEbh6yaHSQTDCi8wuXLYd4qrgXrhTxYbTaLj5qXDRgP",
      }
    `);
  });

  it('verifies, and rejects tampering', () => {
    expect(verifyPayload(mp)).toBe(true);
    const bad = structuredClone(mp);
    bad.payload.message = bad.payload.message.replace('999', '998');
    expect(verifyPayload(bad)).toBe(false);
  });

  it('refuses zero and non-integer amounts', () => {
    const base = { signerId: 'x.testnet', secretKey: KP.secretKeyStr, verifierId: VERIFIER, salt: SALT, deadline: DEADLINE };
    expect(() => signTokenDiff({ ...base, diff: { [W]: '0' } })).toThrow(/zero/);
    expect(() => signTokenDiff({ ...base, diff: { [W]: '1.5' } })).toThrow(/integer/);
  });
});

describe('fee rule (BUILD_PLAN C1)', () => {
  it('is ceil(|d|·fee/1e6)', () => {
    expect(feeOf(1000n, 1)).toBe(1n);
    expect(feeOf(-1000n, 1)).toBe(1n);
    expect(feeOf(1_000_000n, 1)).toBe(1n);
    expect(feeOf(1_000_001n, 1)).toBe(2n);
    expect(feeOf(0n, 1)).toBe(0n);
    expect(feeOf(5n, 0)).toBe(0n);
    expect(netOfFee(1000n, 1)).toBe(999n);
  });
  it('grossForNet is the minimal inverse', () => {
    for (const fee of [0, 1, 100, 10_000]) {
      for (let i = 0; i < 300; i++) {
        const net = BigInt(Math.floor(Math.random() * 1e9)) + 1n;
        const g = grossForNet(net, fee);
        expect(netOfFee(g, fee) >= net).toBe(true);
        expect(netOfFee(g - 1n, fee) < net).toBe(true);
      }
    }
  });
  it('closureDeltas matches the A:-1000 → B:+999 example', () => {
    expect(closureDeltas([{ [W]: -1000n }], 1)).toEqual({ [W]: 999n });
    expect(closureDeltas([{ [W]: 999n }], 1)).toEqual({ [W]: -1000n });
  });
});

describe('error helpers', () => {
  it('extracts panic messages', () => {
    const m = panicMessage(new Error('{"error":"wasm execution failed with error: FunctionCallError(ExecutionError(\\"Smart contract panicked: invalid salt\\"))"}'));
    expect(m).toBe('invalid salt');
    expect(errorClassOf('insufficient balance or overflow')).toBe('insufficient balance or overflow');
    expect(errorClassOf("public key 'ed25519:x' doesn't exist for account 'a'")).toBe('public key not registered');
  });
});
