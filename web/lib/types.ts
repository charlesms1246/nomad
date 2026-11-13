// Shared shape of the matcher REST API (GET /api/state).
// apps/matcher serves this; web/ reads it. Owner of this file: agent2 (UI).
// Field names follow TECH_DOC §4. Amounts are decimal strings in the token's
// smallest units (canonical JSON), never JS numbers.

export type AccountId = string; // e.g. "a03.nomadswarm.testnet"
export type TokenId = string; // e.g. "nep141:usdc.nomadswarm.testnet"
export type Amount = string; // decimal string, smallest units

export interface TokenMeta {
  id: TokenId;
  symbol: string; // "wNEAR", "USDC", ...
  decimals: number;
  priceUsd: number | null; // 1Click mainnet mid price used for USD figures; null if unknown
}

/** One board offer (TECH_DOC §4, contracts/board). */
export interface Offer {
  id: string; // u64 as string
  agent: AccountId;
  give: TokenId;
  giveMax: Amount;
  want: TokenId;
  rateNum: Amount; // min want units per give unit = rateNum / rateDen (smallest units)
  rateDen: Amount;
  expiresAtMs: number;
  createdAtMs: number;
}

export interface AgentState {
  id: AccountId;
  holdings: Record<TokenId, Amount>; // Verifier balances (mt_balance_of)
  offers: Offer[]; // live offers only
  strategy?: string; // "spender" | "rebalancer" | "collector" | "random" | "llm"
  unmatchedRounds?: number; // rounds since its oldest offer was posted without a ring
}

/** One agent's part of a ring. diff = { [give]: -giveAmt, [get]: +getAmt }. */
export interface Leg {
  agent: AccountId;
  give: TokenId;
  giveAmt: Amount;
  get: TokenId;
  getAmt: Amount;
  offerId?: string;
}

export type RingStatus =
  | "proposed" // sent to agents, collecting signatures
  | "signed" // all k legs signed
  | "simulated" // simulate_intents passed
  | "submitted" // execute_intents sent, not yet final
  | "settled" // executed; txHash is final
  | "failed"; // declined, simulate failed, expired, or tx failed

export interface Ring {
  ringId: string; // sha256 of canonical legs + deadline (hex)
  k: number; // number of agents (2..5)
  legs: Leg[]; // cyclic: legs[i].get == legs[i+1].give
  matcher: AccountId;
  matcherLeg: { token: TokenId; amt: Amount }; // matcher's positive-only diff
  signedBy: AccountId[]; // agents whose leg is signed so far (UI lights these legs)
  surplusBps: number; // (S - 1) * 1e4, S = 1 / Π ρ
  matcherShareBps: number; // matcher's cut of the surplus, in bps of the closing leg
  savingsBps: number | null; // mean over legs vs a same-time 1Click dry quote; null if no quote
  savingsUsd: number | null;
  baselineQuotedAtMs: number | null; // timestamp of the 1Click quotes used for savings
  deadline: string; // ISO
  proposedAtMs: number;
  settledAtMs: number | null;
  txHash: string | null;
  blockHeight: number | null;
  blocksToExec: number | null; // blocks from submission to execution
  gasBurntTgas: number | null;
  status: RingStatus;
  error: string | null; // e.g. "insufficient balance or overflow"
}

/** Sim sweep (`make sim`), one point per agent count. */
export interface SwarmPoint {
  agents: number;
  tokens: number;
  clearingRate: number; // share of offers cleared by rings, 0..1
  fallbackRate: number; // share sent to the 1Click fallback, 0..1
  ringsSettled: number;
  meanSavingsBps: number | null;
}

export interface SwarmStats {
  source: "sim" | "live";
  seed: number | null;
  points: SwarmPoint[];
  ringLengthHist: Record<string, number>; // k ("2".."5") -> rings settled
}

export interface RaceMatcher {
  account: AccountId;
  shard: number;
  colocated: boolean; // same shard as the Verifier (colo check)
  wins: number;
  blocksToExecHist: Record<string, number>; // blocks ("0","1","2",...) -> settlements
}

export interface RaceStats {
  rounds: number; // contested rings
  matchers: RaceMatcher[];
}

export interface Meta {
  network: "testnet";
  verifier: AccountId; // "intents.nomadswarm.testnet"
  verifierShard: number | null;
  board: AccountId;
  explorerTxUrl: string; // prefix, tx hash is appended: "https://testnet.nearblocks.io/txns/"
  generatedAtMs: number;
  source: "live" | "mock"; // "mock" = UI fixture, not chain data
  tokens: TokenMeta[];
  /** Headline 1Click baseline, re-measured on the day (IDEA §10.1). */
  baseline: { pair: string; bps: number; quotedAtMs: number } | null;
}

export interface NomadState {
  meta: Meta;
  agents: AgentState[];
  rings: Ring[]; // newest first
  swarm: SwarmStats | null;
  race: RaceStats | null;
}
