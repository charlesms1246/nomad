import type { ShardLayout } from '../src/layout.js';

// Mainnet, protocol 88 (2026-11-13).
export const MAINNET: ShardLayout = {
  boundary_accounts: ['650', 'aurora', 'aurora-0', 'earn.kaiching', 'game.hot.tg', 'game.hot.tg-0', 'kkuuue2akv_1630967379.near', 'tge-lockup.sweat', 'wallet.ka'],
  shard_ids: [10, 11, 1, 8, 9, 6, 7, 4, 12, 13],
};

// Testnet, protocol 88 (2026-11-13), docs/BUILD_PLAN.md §2.
export const TESTNET: ShardLayout = {
  boundary_accounts: ['650', 'aurora', 'aurora-0', 'dev-1662050149030-28642112951491-0', 'earn.kaiching', 'game.hot.tg', 'game.hot.tg-0', 'kkuuue2akv_1630967379.near', 'tge-lockup.sweat'],
  shard_ids: [10, 11, 1, 12, 13, 9, 6, 7, 4, 5],
};
