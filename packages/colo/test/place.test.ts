import { describe, expect, it } from 'vitest';
import { shardOf } from '../src/layout.js';
import { candidateIds, place, planCandidates, prefixLetters } from '../src/place.js';
import { MAINNET, TESTNET } from './layouts.js';

const freeExcept = (taken: string[]) => async (id: string) => !taken.includes(id);

describe('place', () => {
  it('returns the hint itself when free and on-shard', async () => {
    const r = await place('intents.nomadswarm.testnet', { parent: 'nomadswarm.testnet', hint: 'intents-matcher', layout: TESTNET, isFree: freeExcept([]) });
    expect(r.accountId).toBe('intents-matcher.nomadswarm.testnet');
    expect(r.shard).toBe(7);
    expect(r.targetShard).toBe(7);
    expect(r.prefixed).toBeUndefined();
  });

  it('walks hint-1, hint-2 when taken', async () => {
    const r = await place('intents.near', {
      parent: 'nomadswarm.near', hint: 'intents-matcher', layout: MAINNET,
      isFree: freeExcept(['intents-matcher.nomadswarm.near', 'intents-matcher-1.nomadswarm.near']),
    });
    expect(r.accountId).toBe('intents-matcher-2.nomadswarm.near');
    expect(r.tried.map((t) => t.reason)).toEqual(['taken', 'taken']);
  });

  it('prefixes an in-range letter when the hint cannot land (matcher → shard 4, target shard 7)', async () => {
    const r = await place('intents.near', { parent: 'nomadswarm.near', hint: 'matcher', layout: MAINNET, isFree: freeExcept([]) });
    expect(r.prefixed).toBe('h');
    expect(r.accountId).toBe('hmatcher.nomadswarm.near');
    expect(shardOf(r.accountId, MAINNET)).toBe(7);
    expect(r.tried).toEqual([{ accountId: 'matcher.nomadswarm.near', reason: 'off-shard' }]);
  });

  it('every returned id is on the target shard, for many hints and both layouts', async () => {
    for (const [layout, target, parent] of [
      [MAINNET, 'intents.near', 'nomadswarm.near'],
      [TESTNET, 'intents.nomadswarm.testnet', 'nomadswarm.testnet'],
      [TESTNET, 'zz.testnet', 'nomadswarm.testnet'],
      [MAINNET, '0x.near', 'nomadswarm.near'],
    ] as const) {
      for (const hint of ['a', 'matcher', 'zeta', 'game', 'k9', 'intents', '0']) {
        const r = await place(target, { parent, hint, layout, isFree: freeExcept([]) });
        expect(shardOf(r.accountId, layout)).toBe(shardOf(target, layout));
        expect(r.accountId.endsWith('.' + parent)).toBe(true);
      }
    }
  });

  it('prefix letters prefer the interior of the range', () => {
    expect(prefixLetters({ lo: 'game.hot.tg-0', hi: 'kkuuue2akv_1630967379.near' }).slice(0, 3)).toEqual(['h', 'i', 'j']);
  });

  it('candidate order', () => {
    expect(candidateIds('m', 'p.near', 3)).toEqual(['m.p.near', 'm-1.p.near', 'm-2.p.near']);
  });

  it('throws when the range is too narrow for the parent', () => {
    // shard 1 on mainnet is ["aurora", "aurora-0"): only aurora and aurora-… ids, never a sub-account of nomadswarm.near
    expect(() => planCandidates('x', 'nomadswarm.near', { lo: 'aurora', hi: 'aurora-0' })).toThrow(/too narrow/);
  });

  it('rejects bad hints and gives up when everything is taken', async () => {
    await expect(place('intents.near', { parent: 'p.near', hint: 'Bad.Hint', layout: MAINNET, isFree: freeExcept([]) })).rejects.toThrow(/invalid hint/);
    await expect(place('intents.near', { parent: 'p.near', hint: 'intents', layout: MAINNET, maxTries: 3, isFree: async () => false })).rejects.toThrow(/taken/);
  });
});
