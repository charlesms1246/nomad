// Testnet deployment parameters for our Verifier and test tokens.
export const VERIFIER_FEE_PIPS = 1; // same as mainnet intents.near (1 pip = 0.0001 %)
export const VERIFIER_FEE_COLLECTOR = 'fees.nomadswarm.testnet'; // a Verifier-internal balance; needs no on-chain account
export const WNEAR_ID = 'wrap.testnet'; // the Verifier's wnear_id (native NEAR withdrawals)

export interface TestToken {
  sub: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
}

// Our own NEP-141s (releases/fungible-token.wasm from near/intents). `wnear` is a test wNEAR with
// the real 24 decimals but an unbounded supply, so demo rings aren't limited by faucet NEAR.
export const TOKENS: TestToken[] = [
  { sub: 'wnear', name: 'Nomad test wNEAR', symbol: 'wNEAR', decimals: 24, supply: 10n ** 9n * 10n ** 24n },
  { sub: 'usdc', name: 'Nomad test USDC', symbol: 'USDC', decimals: 6, supply: 10n ** 12n * 10n ** 6n },
  { sub: 'usdt', name: 'Nomad test USDT', symbol: 'USDT', decimals: 6, supply: 10n ** 12n * 10n ** 6n },
  { sub: 'btc', name: 'Nomad test BTC', symbol: 'BTC', decimals: 8, supply: 21n * 10n ** 6n * 10n ** 8n },
  { sub: 'zec', name: 'Nomad test ZEC', symbol: 'ZEC', decimals: 8, supply: 21n * 10n ** 6n * 10n ** 8n },
];
