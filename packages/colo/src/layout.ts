import { rpc, type RpcOptions } from './rpc.js';

export interface ShardLayout {
  /** Sorted boundary accounts. Shard i holds ids in [boundary[i-1], boundary[i]). */
  boundary_accounts: string[];
  /** shard_ids[i] is the shard id of the i-th range; length = boundaries + 1. */
  shard_ids: number[];
  version?: string;
  protocol?: number;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; layout: ShardLayout }>();

/** Turn an `EXPERIMENTAL_protocol_config` result into a ShardLayout (V3, else V2, else V1). */
export function layoutFromProtocolConfig(cfg: any): ShardLayout {
  const sl = cfg?.shard_layout;
  if (!sl) throw new Error('protocol config has no shard_layout');
  const version = sl.V3 ? 'V3' : sl.V2 ? 'V2' : sl.V1 ? 'V1' : undefined;
  const l = version ? sl[version] : undefined;
  if (!l || !Array.isArray(l.boundary_accounts)) throw new Error('unsupported shard_layout: ' + Object.keys(sl).join(','));
  const boundary_accounts: string[] = l.boundary_accounts;
  const shard_ids: number[] = l.shard_ids ?? boundary_accounts.map((_, i) => i).concat(boundary_accounts.length);
  if (shard_ids.length !== boundary_accounts.length + 1) throw new Error('shard_ids length must be boundaries + 1');
  return { boundary_accounts, shard_ids, version, protocol: cfg.protocol_version };
}

/** Read the live shard layout, cached for 10 minutes per RPC URL. */
export async function getShardLayout(rpcUrl: string, opts: RpcOptions & { fresh?: boolean } = {}): Promise<ShardLayout> {
  const hit = cache.get(rpcUrl);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.layout;
  const cfg = await rpc(rpcUrl, 'EXPERIMENTAL_protocol_config', { finality: 'final' }, opts);
  const layout = layoutFromProtocolConfig(cfg);
  cache.set(rpcUrl, { at: Date.now(), layout });
  return layout;
}

export function clearLayoutCache(): void {
  cache.clear();
}

/** Index (not shard id) of the range holding `accountId`: the index of the first boundary > id. */
export function rangeIndexOf(accountId: string, layout: ShardLayout): number {
  const b = layout.boundary_accounts;
  let i = 0;
  while (i < b.length && accountId >= b[i]) i++;
  return i;
}

/**
 * Shard id of an account: shard_ids[index of the first boundary > id], with plain
 * (UTF-16 code unit) string comparison, same as the hop-latency probe and nearcore's
 * byte-wise AccountId ordering for the ASCII account alphabet.
 */
export function shardOf(accountId: string, layout: ShardLayout): number {
  return layout.shard_ids[rangeIndexOf(accountId, layout)];
}

/** The [lo, hi) id range of a shard id. lo = '' for the first range, hi = null for the last. */
export function shardRange(shardId: number, layout: ShardLayout): { lo: string; hi: string | null } {
  const i = layout.shard_ids.indexOf(shardId);
  if (i < 0) throw new Error(`shard ${shardId} not in layout`);
  const b = layout.boundary_accounts;
  return { lo: i === 0 ? '' : b[i - 1], hi: i < b.length ? b[i] : null };
}

export function inRange(id: string, r: { lo: string; hi: string | null }): boolean {
  return id >= r.lo && (r.hi === null || id < r.hi);
}
