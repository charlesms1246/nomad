// Helpers for the mandate contract (contracts/mandate) on testnet: deploy, derive the agent's
// Ethereum address from the MPC, set a mandate, request a leg signature and wait for it.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { keccak_256 } from '../packages/intents/node_modules/@noble/hashes/sha3.js';
import {
  ONE_NEAR,
  TGAS,
  b58decode,
  b64encode,
  buildNonce,
  hexencode,
  randomKeyPair,
  saveCredentials,
  hasCredentials,
  signerFor,
} from '../packages/intents/src/index.js';
import { CONFIG, PARENT, ROOT, client, explorer, log, parent, rpc } from './k-lib.js';

export const MANDATE_ID = process.env.MANDATE_ID ?? `mandate.${PARENT}`;
export const MPC_ID = 'v1.signer-prod.testnet';
export const WASM = join(ROOT, 'contracts', 'mandate', 'target', 'near', 'nomad_mandate.wasm');
export const MILLI = ONE_NEAR / 1000n;
export const LEG_DEPOSIT = 10n * MILLI;
export const MANDATE_DEPOSIT = 20n * MILLI;

export const pathFor = (owner: string) => `mandate/${owner}`;

/** The Ethereum address the MPC derives for (predecessor = mandate contract, path). */
export async function derivedAddress(owner: string, contractId = MANDATE_ID): Promise<{ address: string; publicKey: string }> {
  const pk = await rpc.view<string>(MPC_ID, 'derived_public_key', { path: pathFor(owner), predecessor: contractId, domain_id: 0 }, 'final');
  const raw = b58decode(pk.replace(/^secp256k1:/, ''));
  if (raw.length !== 64) throw new Error(`unexpected derived key length ${raw.length}`);
  return { address: '0x' + hexencode(keccak_256(raw).subarray(12)), publicKey: pk };
}

/** Create `mandate.<parent>` with at most 4 NEAR, deploy, init. Idempotent: skips if it already has code. */
export async function ensureDeployed(opts: { redeploy?: boolean; fundNear?: bigint } = {}) {
  const code = readFileSync(WASM);
  const acct = await rpc.viewAccount(MANDATE_ID);
  if (acct && acct.code_hash !== '11111111111111111111111111111111' && !opts.redeploy) {
    log(`${MANDATE_ID} already deployed (code ${acct.code_hash})`);
    return null;
  }
  if (acct && opts.redeploy) {
    const r = await rpc.sendTx(signerFor(MANDATE_ID), MANDATE_ID, [{ type: 'DeployContract', code }]);
    log(`redeploy ${r.txHash} ok=${r.ok} ${r.error ?? ''}`);
    if (!r.ok) throw new Error('redeploy failed');
    return r;
  }
  const kp = randomKeyPair();
  const fund = opts.fundNear ?? (35n * ONE_NEAR) / 10n;
  if (fund > 4n * ONE_NEAR) throw new Error('at most 4 NEAR');
  if (hasCredentials(MANDATE_ID)) throw new Error(`credentials for ${MANDATE_ID} exist but the account does not; move them away first`);
  saveCredentials({ account_id: MANDATE_ID, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
  const r = await rpc.sendTx(parent, MANDATE_ID, [
    { type: 'CreateAccount' },
    { type: 'Transfer', deposit: fund },
    { type: 'AddKey', publicKey: kp.publicKeyStr, permission: 'FullAccess' },
    { type: 'DeployContract', code },
    { type: 'FunctionCall', methodName: 'new', args: { verifier_id: CONFIG.verifierId, mpc_id: MPC_ID }, gas: 30n * TGAS, deposit: 0n },
  ]);
  log(`create+deploy ${MANDATE_ID}: ${r.txHash} ok=${r.ok} ${r.error ?? ''}`);
  if (!r.ok) throw new Error('deploy failed: ' + r.error);
  return r;
}

export interface TokenRule { token: string; max_per_leg: string; daily_budget: string }
export interface PriceRule { give: string; want: string; rate_num: string; rate_den: string }

export async function setMandate(owner: { signerId: string; secretKey: string }, args: {
  eth_address: string; tokens: TokenRule[]; prices: PriceRule[]; min_counterparty_reputation?: number | null; expires_at_ms: number;
}) {
  const r = await rpc.sendTx(owner, MANDATE_ID, [
    { type: 'FunctionCall', methodName: 'set_mandate', args: { args: { min_counterparty_reputation: null, ...args } }, gas: 30n * TGAS, deposit: MANDATE_DEPOSIT },
  ]);
  log(`set_mandate ${r.txHash} ok=${r.ok} ${r.error ?? ''}`);
  return r;
}

export interface LegArgs {
  owner: string;
  give: string;
  give_amount: string;
  get: string;
  get_amount: string;
  deadline_ms: number;
  nonce: string;
  salt: string;
  tip: { token: string; amount: string; receiver_id: string } | null;
}

/** A leg with a fresh Verifier versioned nonce for the current salt. */
export async function makeLeg(p: Omit<LegArgs, 'nonce' | 'salt' | 'deadline_ms' | 'tip'> & { ttlMs?: number; tip?: LegArgs['tip'] }): Promise<LegArgs> {
  const salt = await client.currentSalt(0);
  const deadline_ms = Date.now() + (p.ttlMs ?? 10 * 60_000);
  const nonce = b64encode(buildNonce(salt, BigInt(deadline_ms) * 1_000_000n));
  const { ttlMs, ...rest } = p;
  return { ...rest, tip: p.tip ?? null, deadline_ms, nonce, salt };
}

/** Call request_leg_signature and wait for the whole receipt tree (MPC yield + callback). */
export async function requestLeg(requester: { signerId: string; secretKey: string }, leg: LegArgs) {
  const t0 = Date.now();
  const r = await rpc.sendTx(requester, MANDATE_ID, [
    { type: 'FunctionCall', methodName: 'request_leg_signature', args: { leg }, gas: 150n * TGAS, deposit: LEG_DEPOSIT },
  ], { waitUntil: 'FINAL' });
  const ms = Date.now() - t0;
  log(`request_leg_signature ${r.txHash} ok=${r.ok} ${ms} ms ${r.error ?? ''} ${explorer(r.txHash)}`);
  return { ...r, ms };
}

export async function signedLeg(id: number) {
  return rpc.view<any>(MANDATE_ID, 'signed_leg', { id }, 'optimistic');
}

/** Leg id from the tx: the receipt that called `sign` logs `sign: predecessor=…`; we instead read next_leg_id - 1 before/after. */
export async function nextLegId(): Promise<number> {
  return (await rpc.view<any>(MANDATE_ID, 'config', {}, 'optimistic')).next_leg_id;
}

export async function waitSigned(id: number, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const l = await signedLeg(id);
    if (l && l.status !== 'Pending') return l;
    if (Date.now() - t0 > timeoutMs) return l;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const MEAS = join(ROOT, 'docs', 'measurements', 'mandate.json');
/** Merge a section into docs/measurements/mandate.json. */
export function saveSection(section: string, data: unknown) {
  mkdirSync(join(ROOT, 'docs', 'measurements'), { recursive: true });
  const cur = existsSync(MEAS) ? JSON.parse(readFileSync(MEAS, 'utf8')) : { network: 'testnet', verifier: CONFIG.verifierId, mandate: MANDATE_ID, mpc: MPC_ID };
  cur[section] = { measuredAt: new Date().toISOString(), ...(data as object) };
  writeFileSync(MEAS, JSON.stringify(cur, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  log(`saved ${MEAS} [${section}]`);
}
