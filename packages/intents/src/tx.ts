// Minimal NEAR transaction builder (Borsh), so the package needs no near-api-js.
import { sha256 } from '@noble/hashes/sha256';
import { borshBytes, borshString, concat, u128le, u32le, u64le, u8, b58decode } from './encoding.js';
import { parsePublicKey, sign, type KeyPair } from './keys.js';

export type Action =
  | { type: 'CreateAccount' }
  | { type: 'DeployContract'; code: Uint8Array }
  | { type: 'FunctionCall'; methodName: string; args: Uint8Array | object; gas: bigint; deposit: bigint }
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'AddKey'; publicKey: string; permission: 'FullAccess' | { receiverId: string; methodNames: string[]; allowance?: bigint } }
  | { type: 'DeleteKey'; publicKey: string }
  | { type: 'DeleteAccount'; beneficiaryId: string };

export const TGAS = 1_000_000_000_000n;
export const ONE_NEAR = 10n ** 24n;
export const ONE_YOCTO = 1n;

const pk = (s: string) => concat(u8(0), parsePublicKey(s));

function vec(items: Uint8Array[]): Uint8Array {
  return concat(u32le(items.length), ...items);
}

export function serializeAction(a: Action): Uint8Array {
  switch (a.type) {
    case 'CreateAccount':
      return u8(0);
    case 'DeployContract':
      return concat(u8(1), borshBytes(a.code));
    case 'FunctionCall': {
      const args = a.args instanceof Uint8Array ? a.args : new TextEncoder().encode(JSON.stringify(a.args));
      return concat(u8(2), borshString(a.methodName), borshBytes(args), u64le(a.gas), u128le(a.deposit));
    }
    case 'Transfer':
      return concat(u8(3), u128le(a.deposit));
    case 'AddKey': {
      const perm =
        a.permission === 'FullAccess'
          ? u8(1)
          : concat(
              u8(0),
              a.permission.allowance === undefined ? u8(0) : concat(u8(1), u128le(a.permission.allowance)),
              borshString(a.permission.receiverId),
              vec(a.permission.methodNames.map(borshString)),
            );
      return concat(u8(5), pk(a.publicKey), u64le(0n), perm);
    }
    case 'DeleteKey':
      return concat(u8(6), pk(a.publicKey));
    case 'DeleteAccount':
      return concat(u8(7), borshString(a.beneficiaryId));
  }
}

export interface TxParams {
  signerId: string;
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  blockHash: string; // base58
  actions: Action[];
}

export function serializeTransaction(t: TxParams): Uint8Array {
  const bh = b58decode(t.blockHash);
  if (bh.length !== 32) throw new Error('block hash must be 32 bytes');
  return concat(
    borshString(t.signerId),
    pk(t.publicKey),
    u64le(t.nonce),
    borshString(t.receiverId),
    bh,
    vec(t.actions.map(serializeAction)),
  );
}

/** Returns the signed transaction bytes and the tx hash bytes. */
export function signTransaction(t: TxParams, kp: KeyPair): { signed: Uint8Array; hash: Uint8Array } {
  const body = serializeTransaction(t);
  const hash = sha256(body);
  const sig = sign(hash, kp);
  return { signed: concat(body, u8(0), sig), hash };
}
