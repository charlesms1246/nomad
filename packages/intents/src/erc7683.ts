// ERC-7683 order ingress for Nomad legs: an EVM wallet signs one ring leg as an EIP-712
// GaslessCrossChainOrder, and the rings contract checks it with ecrecover.
//
// Which ERC-7683? The struct is the one in the *earlier* ERC-7683 draft (ethereum/ERCs commit
// 5635555492, 2025-01-08), which defined GaslessCrossChainOrder as
//   (address originSettler, address user, uint256 nonce, uint256 originChainId,
//    uint32 openDeadline, uint32 fillDeadline, bytes32 orderDataType, bytes orderData)
// in that order. The ERC was redesigned around resolvers on 2026-05-13 (commit 96d110fbbe), and
// the current text no longer defines that struct. The earlier draft never fixed an EIP-712
// domain or a typehash for the order itself; it left them to each protocol. So the following are
// NOMAD CONVENTIONS, agreed with the Rust verifier in contracts/rings:
//   - domain: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//     with name "Nomad", version "1", verifyingContract 0x0 (the settler is a NEAR account and
//     has no EVM address), and chainId from the EIP-155 registry (ethereum-lists/chains):
//     397 = NEAR Protocol (mainnet), 398 = NEAR Protocol Testnet.
//   - originSettler = 0x0; originChainId = the same chain id as the domain.
//   - orderDataType = keccak256("NomadLeg(string give,uint256 giveAmount,string want,uint256 minWantAmount)").
//   - orderData = abi.encode(string give, uint256 giveAmount, string want, uint256 minWantAmount)
//     (four parameters, not a wrapped tuple). Tokens are Verifier ids ("nep141:…").
//   - `bytes orderData` is hashed as keccak256(orderData) in the struct hash, per EIP-712.
//   - digest = keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(order)).

import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const enc = new TextEncoder();
const keccak = (b: Uint8Array | string) => keccak_256(typeof b === 'string' ? enc.encode(b) : b);

export const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const GASLESS_ORDER_TYPE =
  'GaslessCrossChainOrder(address originSettler,address user,uint256 nonce,uint256 originChainId,uint32 openDeadline,uint32 fillDeadline,bytes32 orderDataType,bytes orderData)';
export const NOMAD_LEG_TYPE = 'NomadLeg(string give,uint256 giveAmount,string want,uint256 minWantAmount)';

export const EIP712_DOMAIN_TYPEHASH = keccak(EIP712_DOMAIN_TYPE);
export const GASLESS_ORDER_TYPEHASH = keccak(GASLESS_ORDER_TYPE);
export const NOMAD_LEG_TYPEHASH = keccak(NOMAD_LEG_TYPE);

export const NEAR_CHAIN_ID = { mainnet: 397n, testnet: 398n } as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface NomadDomain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}
export const nomadDomain = (network: 'mainnet' | 'testnet' = 'testnet'): NomadDomain => ({
  name: 'Nomad',
  version: '1',
  chainId: NEAR_CHAIN_ID[network],
  verifyingContract: ZERO_ADDRESS,
});

export interface NomadLeg {
  give: string;
  giveAmount: bigint;
  want: string;
  minWantAmount: bigint;
}

export interface GaslessCrossChainOrder {
  originSettler: string; // 0x-prefixed 20-byte hex
  user: string; // 0x-prefixed 20-byte hex
  nonce: bigint;
  originChainId: bigint;
  openDeadline: number; // uint32, unix seconds
  fillDeadline: number; // uint32, unix seconds
  orderDataType: Uint8Array; // bytes32
  orderData: Uint8Array;
}

// ---- ABI encoding (only what we need) ----
const U256_MAX = (1n << 256n) - 1n;
export function word(x: bigint): Uint8Array {
  if (x < 0n || x > U256_MAX) throw new Error('uint256 out of range');
  return hexToBytes(x.toString(16).padStart(64, '0'));
}
function uintN(x: bigint | number, bits: number): Uint8Array {
  const v = BigInt(x);
  if (v < 0n || v >= 1n << BigInt(bits)) throw new Error(`uint${bits} out of range`);
  return word(v);
}
function address(a: string): Uint8Array {
  const h = a.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`bad address ${a}`);
  const w = new Uint8Array(32);
  w.set(hexToBytes(h), 12);
  return w;
}
function bytes32(b: Uint8Array): Uint8Array {
  if (b.length !== 32) throw new Error('bytes32 must be 32 bytes');
  return b;
}
const concat = (...xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
/** ABI tail encoding of a dynamic `string`/`bytes`: length word + data padded to 32 bytes. */
function dynTail(b: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return concat(word(BigInt(b.length)), padded);
}

/** abi.encode(string give, uint256 giveAmount, string want, uint256 minWantAmount): four head words, then the two string tails. */
export function encodeNomadLeg(l: NomadLeg): Uint8Array {
  const give = dynTail(enc.encode(l.give));
  const want = dynTail(enc.encode(l.want));
  const headLen = 4 * 32;
  return concat(
    word(BigInt(headLen)), // offset of give
    uintN(l.giveAmount, 256),
    word(BigInt(headLen + give.length)), // offset of want
    uintN(l.minWantAmount, 256),
    give,
    want,
  );
}

/** EVM address of a secp256k1 key. */
export function evmAddress(publicKey: Uint8Array): string {
  const pt = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false); // 65 bytes, 0x04 prefix
  return '0x' + bytesToHex(keccak(pt.slice(1)).slice(12));
}

export function domainSeparator(d: NomadDomain): Uint8Array {
  return keccak(concat(EIP712_DOMAIN_TYPEHASH, keccak(d.name), keccak(d.version), word(d.chainId), address(d.verifyingContract)));
}

export function orderStructHash(o: GaslessCrossChainOrder): Uint8Array {
  return keccak(
    concat(
      GASLESS_ORDER_TYPEHASH,
      address(o.originSettler),
      address(o.user),
      uintN(o.nonce, 256),
      uintN(o.originChainId, 256),
      uintN(o.openDeadline, 32),
      uintN(o.fillDeadline, 32),
      bytes32(o.orderDataType),
      keccak(o.orderData),
    ),
  );
}

/** EIP-712 digest: keccak256(0x1901 ‖ domainSeparator ‖ structHash). */
export function orderDigest(o: GaslessCrossChainOrder, d: NomadDomain): Uint8Array {
  return keccak(concat(new Uint8Array([0x19, 0x01]), domainSeparator(d), orderStructHash(o)));
}

export interface BuildLegOrder {
  leg: NomadLeg;
  /** uint256 nonce. Using the leg's 32-byte Verifier nonce (big-endian) keeps one-of-N semantics. */
  nonce: bigint | Uint8Array;
  user: string;
  /** Unix seconds (uint32). */
  openDeadline: number;
  fillDeadline: number;
  domain: NomadDomain;
}

export function buildLegOrder(b: BuildLegOrder): GaslessCrossChainOrder {
  const nonce = b.nonce instanceof Uint8Array ? BigInt('0x' + bytesToHex(b.nonce)) : b.nonce;
  return {
    originSettler: ZERO_ADDRESS,
    user: b.user,
    nonce,
    originChainId: b.domain.chainId,
    openDeadline: b.openDeadline,
    fillDeadline: b.fillDeadline,
    orderDataType: NOMAD_LEG_TYPEHASH,
    orderData: encodeNomadLeg(b.leg),
  };
}

export interface Erc7683Signature {
  r: string; // 0x + 32 bytes
  s: string; // 0x + 32 bytes (low-s)
  v: 27 | 28;
  /** 65-byte r ‖ s ‖ v, as Ethereum wallets return it. */
  rsv: string;
}

/** Sign the digest with a secp256k1 key (RFC 6979, low-s), like eth_signTypedData_v4. */
export function signOrder(o: GaslessCrossChainOrder, d: NomadDomain, privateKey: Uint8Array): Erc7683Signature {
  const sig = secp256k1.sign(orderDigest(o, d), privateKey, { lowS: true });
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const v = (27 + sig.recovery) as 27 | 28;
  return { r: '0x' + r, s: '0x' + s, v, rsv: '0x' + r + s + v.toString(16) };
}

/** Recover the signer's EVM address from a 65-byte r‖s‖v signature (what ecrecover does). */
export function recoverOrderSigner(o: GaslessCrossChainOrder, d: NomadDomain, rsv: string): string {
  const b = hexToBytes(rsv.replace(/^0x/, ''));
  if (b.length !== 65) throw new Error('signature must be 65 bytes');
  const v = b[64]!;
  const rec = v >= 27 ? v - 27 : v;
  const sig = secp256k1.Signature.fromCompact(b.slice(0, 64)).addRecoveryBit(rec);
  const pub = sig.recoverPublicKey(orderDigest(o, d)).toRawBytes(false);
  return evmAddress(pub);
}
