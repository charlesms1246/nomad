// Port of docs/spec/supplementary/probes/scripts/intents-hop-latency.mjs.
// For txs to `target`, measures blocks between the tx's inclusion and the target's first
// receipt executing, split by whether the signer sits on the target's shard.
import { getShardLayout, shardOf } from './layout.js';
import { DEFAULT_TARGET, rpc, rpcUrlFor, type Network } from './rpc.js';

export interface LatencyOptions {
  target?: string;
  /** Blocks to scan back from the final head (minus a 30-block margin). Default 400. */
  blocks?: number;
  network?: Network;
  rpcUrl?: string;
  /** Max samples per group (same/cross). Default 80. */
  sample?: number;
  concurrency?: number;
}

export interface LatencySample {
  hash: string;
  signer: string;
  height: number;
  method?: string;
  signerShard: number;
  delta: number;
  ok: boolean;
}

export interface LatencyStat {
  n: number;
  mean: number | null;
  median: number | null;
  hist: Record<string, number>;
}

export interface LatencyReport {
  measuredAt: string;
  network: Network;
  protocol?: number;
  target: string;
  targetShard: number;
  span: { from: number; to: number; blocks: number };
  txsToTarget: number;
  sameShardSignerTxs: number;
  topSigners: [string, number, number][];
  sameShard: LatencyStat;
  crossShard: LatencyStat;
  samples: LatencySample[];
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await f(xs[k]);
      }
    }),
  );
  return out;
}

export function stat(deltas: number[]): LatencyStat {
  const d = [...deltas].sort((a, b) => a - b);
  const hist: Record<string, number> = {};
  for (const x of d) hist[x] = (hist[x] || 0) + 1;
  return {
    n: d.length,
    mean: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2) : null,
    median: d.length ? d[Math.floor(d.length / 2)] : null,
    hist,
  };
}

export async function latency(opts: LatencyOptions = {}): Promise<LatencyReport> {
  const network = opts.network ?? 'testnet';
  const url = rpcUrlFor(network, opts.rpcUrl);
  const target = opts.target ?? DEFAULT_TARGET[network];
  const N = opts.blocks ?? 400;
  const sample = opts.sample ?? 80;
  const conc = opts.concurrency ?? 4;
  const call = (m: string, p: unknown) => rpc(url, m, p);

  const layout = await getShardLayout(url);
  const TS = shardOf(target, layout);
  const head = await call('block', { finality: 'final' });
  const H = head.header.height - 30; // leave room for receipts to land
  const blocks = (
    await pool(Array.from({ length: N }, (_, i) => H - i), 3, (h) => call('block', { block_id: h }).catch(() => null))
  ).filter(Boolean) as any[];
  if (!blocks.length) throw new Error('latency: no blocks fetched');
  const heightCache = new Map<string, number>(blocks.map((b) => [b.header.hash, b.header.height]));
  // Transactions sit in the signer's shard chunk, so read every shard's chunk.
  const chunkRefs = blocks.flatMap((b) =>
    b.chunks
      .filter((c: any) => c.height_included === b.header.height)
      .map((c: any) => ({ hash: c.chunk_hash as string, height: b.header.height as number })),
  );
  const chunks = await pool(chunkRefs, conc, (c) =>
    call('chunk', { chunk_id: c.hash })
      .then((r) => ({ ...c, txs: r.transactions as any[] }))
      .catch(() => null),
  );
  const txs: { hash: string; signer: string; height: number; method?: string }[] = [];
  for (const c of chunks) {
    if (!c) continue;
    for (const t of c.txs) {
      if (t.receiver_id !== target) continue;
      const a0 = t.actions?.[0];
      const method = a0?.FunctionCall?.method_name ?? (typeof a0 === 'string' ? a0 : Object.keys(a0 || {})[0]);
      txs.push({ hash: t.hash, signer: t.signer_id, height: c.height, method });
    }
  }
  const same = txs.filter((t) => shardOf(t.signer, layout) === TS);
  const cross = txs.filter((t) => shardOf(t.signer, layout) !== TS);
  const hOf = async (bh: string) => {
    if (!heightCache.has(bh)) heightCache.set(bh, (await call('block', { block_id: bh })).header.height);
    return heightCache.get(bh)!;
  };
  const measure = async (t: (typeof txs)[number]): Promise<LatencySample | null> => {
    try {
      const o = await call('tx', { tx_hash: t.hash, sender_account_id: t.signer, wait_until: 'NONE' });
      const first = o.receipts_outcome.find((r: any) => r.outcome.executor_id === target);
      if (!first) return null;
      const execH = await hOf(first.block_hash);
      return { ...t, signerShard: shardOf(t.signer, layout), delta: execH - t.height, ok: !('Failure' in (o.status || {})) };
    } catch {
      return null;
    }
  };
  const rs = (await pool([...same.slice(0, sample), ...cross.slice(0, sample)], conc, measure)).filter(
    (x): x is LatencySample => x !== null,
  );
  const sg: Record<string, number> = {};
  for (const t of txs) sg[t.signer] = (sg[t.signer] || 0) + 1;
  return {
    measuredAt: new Date().toISOString(),
    network,
    protocol: layout.protocol,
    target,
    targetShard: TS,
    span: { from: blocks.at(-1).header.height, to: blocks[0].header.height, blocks: blocks.length },
    txsToTarget: txs.length,
    sameShardSignerTxs: same.length,
    topSigners: Object.entries(sg)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([s, n]) => [s, n, shardOf(s, layout)] as [string, number, number]),
    sameShard: stat(rs.filter((r) => r.signerShard === TS).map((r) => r.delta)),
    crossShard: stat(rs.filter((r) => r.signerShard !== TS).map((r) => r.delta)),
    samples: rs,
  };
}
