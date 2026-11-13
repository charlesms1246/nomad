// Live RPC test. Run with COLO_LIVE=1 (node --dns-result-order=ipv4first if IPv6 is flaky).
import { describe, expect, it } from 'vitest';
import { accountIsFree, check, getShardLayout, place, RPC_URLS, where } from '../src/index.js';

const live = process.env.COLO_LIVE === '1';

describe.skipIf(!live)('colo live', () => {
  it('mainnet: intents.near is on the shard the layout says; layout is cached', async () => {
    const l1 = await getShardLayout(RPC_URLS.mainnet);
    const l2 = await getShardLayout(RPC_URLS.mainnet);
    expect(l2).toBe(l1);
    expect(l1.shard_ids.length).toBe(l1.boundary_accounts.length + 1);
    const w = await where('intents.near', { network: 'mainnet' });
    console.log('mainnet intents.near →', w.shard);
    expect(await accountIsFree(RPC_URLS.mainnet, 'intents.near')).toBe(false);
  }, 30_000);

  it('testnet: verifier shard and matcher placement', async () => {
    const w = await where('intents.nomadswarm.testnet');
    const p = await place('intents.nomadswarm.testnet', { parent: 'nomadswarm.testnet', hint: 'intents-matcher' });
    const c = await check({ account: p.accountId });
    console.log(JSON.stringify({ verifier: w, place: p, check: c }));
    expect(p.shard).toBe(w.shard);
    expect(c.colocated).toBe(true);
  }, 60_000);
});
