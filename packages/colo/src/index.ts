import { getShardLayout, shardOf, shardRange, type ShardLayout } from './layout.js';
import { DEFAULT_TARGET, rpcUrlFor, type Network } from './rpc.js';

export * from './rpc.js';
export * from './layout.js';
export * from './place.js';
export * from './latency.js';

export interface NetOptions {
  network?: Network;
  rpcUrl?: string;
  layout?: ShardLayout;
}

async function layoutFor(opts: NetOptions): Promise<ShardLayout> {
  return opts.layout ?? getShardLayout(rpcUrlFor(opts.network, opts.rpcUrl));
}

export interface WhereResult {
  accountId: string;
  shard: number;
  range: { lo: string; hi: string | null };
}

/** Which shard an account id lives on, under the live layout. The account need not exist. */
export async function where(accountId: string, opts: NetOptions = {}): Promise<WhereResult> {
  const layout = await layoutFor(opts);
  const shard = shardOf(accountId, layout);
  return { accountId, shard, range: shardRange(shard, layout) };
}

export interface CheckResult {
  account: string;
  accountShard: number;
  target: string;
  targetShard: number;
  colocated: boolean;
}

/** Is `account` on `target`'s shard? Target defaults to the network's verifier. */
export async function check(
  args: { account: string; target?: string },
  opts: NetOptions = {},
): Promise<CheckResult> {
  const layout = await layoutFor(opts);
  const target = args.target ?? DEFAULT_TARGET[opts.network ?? 'testnet'];
  const accountShard = shardOf(args.account, layout);
  const targetShard = shardOf(target, layout);
  return { account: args.account, accountShard, target, targetShard, colocated: accountShard === targetShard };
}
