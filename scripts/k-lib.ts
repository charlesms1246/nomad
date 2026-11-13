// Shared helpers for the kill tests (K1–K8) against our testnet Verifier.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IntentsClient,
  NearRpc,
  TESTNET_RPC,
  implicitAccountId,
  loadCredentials,
  randomKeyPair,
  signIntents,
  signTokenDiff,
  signerFor,
  type KeyPair,
  type MultiPayload,
} from '../packages/intents/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const CONFIG = JSON.parse(
  (await import('node:fs')).readFileSync(join(ROOT, 'config', 'testnet.json'), 'utf8'),
) as {
  rpcUrl: string;
  verifierId: string;
  feePips: number;
  feeCollector: string;
  tokenOwner: string;
  tokens: { symbol: string; contract: string; id: string; decimals: number }[];
};

export const PARENT = CONFIG.tokenOwner;
export const rpc = new NearRpc(process.env.NEAR_RPC ?? CONFIG.rpcUrl ?? TESTNET_RPC);
export const client = new IntentsClient({ rpc, verifierId: CONFIG.verifierId });
export const parent = signerFor(PARENT);
export const T = Object.fromEntries(CONFIG.tokens.map((t) => [t.symbol, t])) as Record<string, (typeof CONFIG.tokens)[number]>;
export const TOKEN_IDS = CONFIG.tokens.map((t) => t.id);
export const contractOf = (tokenId: string) => tokenId.replace(/^nep141:/, '');

export interface Agent {
  id: string;
  kp: KeyPair;
  secretKey: string;
}

/** A fresh implicit-account agent: the account id is the hex public key, so no registration is needed. */
export function implicitAgent(): Agent {
  const kp = randomKeyPair();
  return { id: implicitAccountId(kp.publicKey), kp, secretKey: kp.secretKeyStr };
}

let funderReady = false;
/**
 * Make sure the parent holds `need` of each token inside the Verifier and that its key is registered
 * (so it can sign fee-free `transfer` intents to fund many agents in one batch).
 */
export async function ensureFunder(need: Record<string, bigint>) {
  if (!funderReady) {
    const c = loadCredentials(PARENT);
    if (!(await client.hasPublicKey(PARENT, c.public_key))) {
      const r = await client.addPublicKey(parent, c.public_key);
      log(`funder add_public_key ${r.txHash} ok=${r.ok}`);
    }
    funderReady = true;
  }
  for (const [tokenId, amt] of Object.entries(need)) {
    const have = await client.mtBalanceOf(PARENT, tokenId);
    if (have >= amt) continue;
    const top = (amt - have) * 10n; // over-deposit so later runs don't redeposit
    const r = await client.deposit(parent, contractOf(tokenId), top);
    log(`funder deposit ${top} ${tokenId}: ${r.txHash} ok=${r.ok}${r.error ? ' ' + r.error : ''}`);
    if (!r.ok) throw new Error('deposit failed');
  }
}

/** Fund agents inside the Verifier with one `execute_intents` of fee-free `transfer` intents from the parent. */
export async function fundAgents(grants: { to: string; tokens: Record<string, bigint> }[]) {
  const need: Record<string, bigint> = {};
  for (const g of grants) for (const [t, a] of Object.entries(g.tokens)) need[t] = (need[t] ?? 0n) + a;
  await ensureFunder(need);
  const signed = signIntents({
    signerId: PARENT,
    secretKey: parent.secretKey,
    verifierId: CONFIG.verifierId,
    salt: await client.currentSalt(),
    deadline: new Date(Date.now() + 10 * 60_000),
    intents: grants.map((g) => ({
      intent: 'transfer',
      receiver_id: g.to,
      tokens: Object.fromEntries(Object.entries(g.tokens).map(([t, a]) => [t, a.toString()])),
    })),
  });
  const r = await client.execute([signed], parent);
  log(`fund ${grants.length} agents: ${r.txHash} ok=${r.ok}${r.error ? ' ' + r.error : ''}`);
  if (!r.ok) throw new Error('funding failed: ' + r.error);
  return r;
}

export async function legFor(agent: { id: string; secretKey: string }, diff: Record<string, bigint>, opts: { deadline?: Date; salt?: string; memo?: string; nonce?: Uint8Array } = {}): Promise<MultiPayload> {
  return signTokenDiff({
    signerId: agent.id,
    secretKey: agent.secretKey,
    verifierId: CONFIG.verifierId,
    salt: opts.salt ?? (await client.currentSalt()),
    deadline: opts.deadline ?? new Date(Date.now() + 120_000),
    diff: Object.fromEntries(Object.entries(diff).map(([t, a]) => [t, a.toString()])),
    memo: opts.memo,
    nonce: opts.nonce,
  });
}

export async function balances(accounts: string[], tokens: string[] = TOKEN_IDS) {
  const out: Record<string, Record<string, string>> = {};
  for (const a of accounts) {
    const b = await client.mtBatchBalanceOf(a, tokens);
    out[a] = Object.fromEntries(tokens.map((t, i) => [t, b[i]!.toString()]));
  }
  return out;
}

export function log(...a: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

/** Write a kill-test result as JSON to docs/measurements/<name>.json. */
export function saveResult(name: string, data: unknown) {
  const dir = join(ROOT, 'docs', 'measurements');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.json`);
  writeFileSync(
    f,
    JSON.stringify({ measuredAt: new Date().toISOString(), network: 'testnet', verifier: CONFIG.verifierId, ...(data as object) }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n',
  );
  log(`saved ${f}`);
}

export const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

/** Tokens for a k-ring: agent i gives tok(i) and gets tok(i+1 mod k); no agent gives what it gets. */
export function ringTokens(k: number, pool: string[] = TOKEN_IDS): string[] {
  let m = Math.min(k, pool.length);
  while (m > 2 && (k - 1) % m === 0) m--;
  const toks = Array.from({ length: k }, (_, i) => pool[i % m]!);
  for (let i = 0; i < k; i++) if (toks[i] === toks[(i + 1) % k]) throw new Error(`bad ring tokens for k=${k}`);
  return toks;
}

/**
 * Fee-correct ring diffs: agent i gives x of tok(i) and receives x − ceil(x·fee/1e6) of tok(i+1).
 * Every token then satisfies Σ positives = Σ (|neg| − fee) (BUILD_PLAN C1).
 */
export function ringDiffs(k: number, x: bigint, feePips: number, toks = ringTokens(k)): Record<string, bigint>[] {
  const fee = (x * BigInt(feePips) + 999_999n) / 1_000_000n;
  return toks.map((t, i) => ({ [t]: -x, [toks[(i + 1) % k]!]: x - fee }));
}
