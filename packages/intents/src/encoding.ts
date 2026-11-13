// Byte helpers: base58, base64, little-endian ints and Borsh primitives.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function b58encode(buf: Uint8Array): string {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

export const b64encode = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
export const hexencode = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export function hexdecode(s: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error(`invalid hex '${s}'`);
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff);
}
export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
  return b;
}
export function i64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt.asIntN(64, n), true);
  return b;
}
export function u128le(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 128n) throw new Error(`u128 out of range: ${n}`);
  return concat(u64le(n & ((1n << 64n) - 1n)), u64le(n >> 64n));
}

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);

/** Borsh `String`: u32 LE byte length, then UTF-8 bytes. */
export const borshString = (s: string): Uint8Array => {
  const b = utf8(s);
  return concat(u32le(b.length), b);
};
/** Borsh `Vec<u8>`. */
export const borshBytes = (b: Uint8Array): Uint8Array => concat(u32le(b.length), b);
