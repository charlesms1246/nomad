import { describe, expect, it } from 'vitest';
import { layoutFromProtocolConfig, shardOf, shardRange } from '../src/layout.js';
import { check, where } from '../src/index.js';
import { MAINNET, TESTNET } from './layouts.js';

describe('shardOf (mainnet layout)', () => {
  it('matches the measured placements', () => {
    expect(shardOf('intents.near', MAINNET)).toBe(7);
    expect(shardOf('intents-matcher.nomadswarm.near', MAINNET)).toBe(7);
    expect(shardOf('matcher.nomadswarm.near', MAINNET)).toBe(4);
    expect(shardOf('escrow.ai.near', MAINNET)).toBe(9);
  });
  it('a boundary account belongs to the shard it opens (first boundary strictly greater)', () => {
    expect(shardOf('game.hot.tg-0', MAINNET)).toBe(7);
    expect(shardOf('game.hot.tg', MAINNET)).toBe(6);
    expect(shardOf('kkuuue2akv_1630967379.near', MAINNET)).toBe(4);
    expect(shardOf('wallet.ka', MAINNET)).toBe(13);
    expect(shardOf('0', MAINNET)).toBe(10);
    expect(shardOf('zzz.near', MAINNET)).toBe(13);
  });
  it('uses plain string comparison', () => {
    // '-' (0x2d) < '.' (0x2e): aurora-0 < aurora.x
    expect(shardOf('aurora', MAINNET)).toBe(1);
    expect(shardOf('aurora.pool.near', MAINNET)).toBe(8);
  });
});

describe('shardOf (testnet layout)', () => {
  it('places our testnet accounts', () => {
    expect(shardOf('intents.nomadswarm.testnet', TESTNET)).toBe(7);
    expect(shardOf('intents-matcher.nomadswarm.testnet', TESTNET)).toBe(7);
    expect(shardOf('matcher.nomadswarm.testnet', TESTNET)).toBe(4);
    expect(shardOf('nomadswarm.testnet', TESTNET)).toBe(4);
    expect(shardOf('board.nomadswarm.testnet', TESTNET)).toBe(12);
  });
  it('shardRange gives [lo, hi)', () => {
    expect(shardRange(7, TESTNET)).toEqual({ lo: 'game.hot.tg-0', hi: 'kkuuue2akv_1630967379.near' });
    expect(shardRange(10, TESTNET)).toEqual({ lo: '', hi: '650' });
    expect(shardRange(5, TESTNET)).toEqual({ lo: 'tge-lockup.sweat', hi: null });
  });
});

describe('layoutFromProtocolConfig', () => {
  it('prefers V3, falls back to V2', () => {
    const v3 = layoutFromProtocolConfig({ protocol_version: 88, shard_layout: { V3: { ...TESTNET, shards_split_map: {} } } });
    expect(v3).toMatchObject({ ...TESTNET, version: 'V3', protocol: 88 });
    const v2 = layoutFromProtocolConfig({ shard_layout: { V2: MAINNET } });
    expect(v2.version).toBe('V2');
    expect(shardOf('intents.near', v2)).toBe(7);
  });
  it('defaults shard_ids to 0..n for V1', () => {
    const v1 = layoutFromProtocolConfig({ shard_layout: { V1: { boundary_accounts: ['m'] } } });
    expect(v1.shard_ids).toEqual([0, 1]);
  });
});

describe('where / check with a fixed layout', () => {
  it('where', async () => {
    expect(await where('intents.near', { layout: MAINNET })).toMatchObject({ shard: 7 });
  });
  it('check', async () => {
    const ok = await check({ account: 'intents-matcher.nomadswarm.testnet' }, { layout: TESTNET });
    expect(ok).toMatchObject({ target: 'intents.nomadswarm.testnet', colocated: true, accountShard: 7, targetShard: 7 });
    const bad = await check({ account: 'matcher.nomadswarm.near', target: 'intents.near' }, { layout: MAINNET, network: 'mainnet' });
    expect(bad).toMatchObject({ colocated: false, accountShard: 4, targetShard: 7 });
  });
});
