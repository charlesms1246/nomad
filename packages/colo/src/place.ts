import { getShardLayout, inRange, shardOf, shardRange, type ShardLayout } from './layout.js';
import { accountIsFree, rpcUrlFor, type Network } from './rpc.js';

export interface PlaceOptions {
  parent: string;
  /** Sub-account label to start from (no dots). Default "matcher". */
  hint?: string;
  network?: Network;
  rpcUrl?: string;
  /** Use this layout instead of reading it live (tests, offline). */
  layout?: ShardLayout;
  /** Free-ness check; defaults to view_account → UNKNOWN_ACCOUNT. */
  isFree?: (accountId: string) => Promise<boolean>;
  /** Suffixes to try per base name (hint, hint-1, …, hint-(maxTries-1)). Default 50. */
  maxTries?: number;
}

export interface Tried {
  accountId: string;
  reason: 'taken' | 'off-shard';
}

export interface PlaceResult {
  accountId: string;
  shard: number;
  target: string;
  targetShard: number;
  range: { lo: string; hi: string | null };
  /** Set when the hint's first letter could not land on the shard and a letter was prefixed. */
  prefixed?: string;
  tried: Tried[];
}

const LABEL = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

/** Candidate ids for a base label: base.P, base-1.P, base-2.P, … */
export function candidateIds(base: string, parent: string, n: number): string[] {
  return Array.from({ length: n }, (_, k) => (k === 0 ? `${base}.${parent}` : `${base}-${k}.${parent}`)).filter(
    (id) => id.length <= 64,
  );
}

/**
 * Letters to prefix when the hint itself cannot land in [lo, hi). Letters strictly inside the
 * range's first characters come first (they work for any hint), the edge letters last.
 */
export function prefixLetters(range: { lo: string; hi: string | null }): string[] {
  const lo = range.lo[0] ?? '';
  const hi = range.hi?.[0];
  const interior = ALPHABET.filter((c) => c > lo && (hi === undefined || c < hi));
  const edge = ALPHABET.filter((c) => c === lo || c === hi);
  return [...interior, ...edge];
}

/**
 * Pick the base label(s) whose candidates fall inside the shard range, without any RPC.
 * Returns the base and the in-range candidate ids, in order.
 */
export function planCandidates(
  hint: string,
  parent: string,
  range: { lo: string; hi: string | null },
  maxTries = 50,
): { base: string; prefixed?: string; ids: string[]; offShard: string[] } {
  const all = candidateIds(hint, parent, maxTries);
  const ids = all.filter((id) => inRange(id, range));
  if (ids.length) return { base: hint, ids, offShard: all.filter((id) => !inRange(id, range)) };
  for (const c of prefixLetters(range)) {
    const base = `${c}${hint}`;
    const cand = candidateIds(base, parent, maxTries).filter((id) => inRange(id, range));
    if (cand.length) return { base, prefixed: c, ids: cand, offShard: all.slice(0, 1) };
  }
  throw new Error(
    `no sub-account of ${parent} can land in [${JSON.stringify(range.lo)}, ${JSON.stringify(range.hi)}) ` +
      `with hint "${hint}" (the range may be too narrow for this parent)`,
  );
}

/** Find a free sub-account `${hint}[-k].${parent}` (or a letter-prefixed variant) on target's shard. */
export async function place(target: string, opts: PlaceOptions): Promise<PlaceResult> {
  const parent = opts.parent;
  const hint = opts.hint ?? 'matcher';
  if (!parent) throw new Error('place: --parent is required');
  if (!LABEL.test(hint)) throw new Error(`place: invalid hint "${hint}" (lowercase a-z, 0-9, single - or _ between)`);
  const url = rpcUrlFor(opts.network, opts.rpcUrl);
  const layout = opts.layout ?? (await getShardLayout(url));
  const isFree = opts.isFree ?? ((id: string) => accountIsFree(url, id));
  const targetShard = shardOf(target, layout);
  const range = shardRange(targetShard, layout);
  const plan = planCandidates(hint, parent, range, opts.maxTries ?? 50);
  const tried: Tried[] = plan.offShard.map((accountId) => ({ accountId, reason: 'off-shard' as const }));
  for (const id of plan.ids) {
    if (await isFree(id)) {
      return { accountId: id, shard: shardOf(id, layout), target, targetShard, range, prefixed: plan.prefixed, tried };
    }
    tried.push({ accountId: id, reason: 'taken' });
  }
  throw new Error(`place: all ${plan.ids.length} candidates for "${plan.base}.${parent}" on shard ${targetShard} are taken`);
}
