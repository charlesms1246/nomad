// Testnet deployment config. Written by agent1's deploy scripts to config/testnet.json; defaults below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface TokenCfg {
  symbol: string;
  contract: string;
  id: string; // nep141:<contract>
  decimals: number;
  mainnetAsset?: string; // 1Click asset id used for prices and the baseline (read-only)
}

export interface NomadConfig {
  network: "testnet";
  rpcUrl?: string;
  parent: string;
  verifierId: string;
  boardId?: string;
  matcherId?: string;
  controlMatcherId?: string;
  relayerMatcherId?: string;
  feePips?: number;
  tokens: TokenCfg[];
}

export const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const keysDir = () => process.env.KEYS_DIR ?? path.join(repoRoot(), "keys");

export function loadConfig(): NomadConfig {
  const file = process.env.NOMAD_CONFIG ?? path.join(repoRoot(), "config", "testnet.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return {
    network: "testnet",
    parent: raw.parent ?? process.env.PARENT_ACCOUNT ?? "nomadswarm.testnet",
    verifierId: raw.verifierId ?? process.env.VERIFIER_ID ?? "intents.nomadswarm.testnet",
    boardId: raw.boardId ?? process.env.BOARD_ID ?? "board.nomadswarm.testnet",
    matcherId: raw.matcherId ?? process.env.MATCHER_ID,
    controlMatcherId: raw.controlMatcherId ?? process.env.CONTROL_MATCHER_ID,
    rpcUrl: raw.rpcUrl ?? process.env.RPC_URL,
    feePips: raw.feePips,
    tokens: raw.tokens ?? [],
  };
}

/** Live agents are aNN; `make fixtures` uses its own fxNN agents so live trading never drains them. */
export const agentIds = (n: number, parent: string, prefix = process.env.AGENT_PREFIX ?? "a") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}.${parent}`);

export function readKey(accountId: string, kind: "intents" | "board" | "relayer") {
  const f = path.join(keysDir(), `${accountId}.${kind}.json`);
  const k = JSON.parse(fs.readFileSync(f, "utf8"));
  return { signerId: k.account_id as string, secretKey: k.private_key as string, publicKey: k.public_key as string };
}

/**
 * Demo inventory plan: what each agent holds and wants. Chosen so that loops of 3, 4 and 5
 * exist (a01-a03: ZEC->USDC->wNEAR; a04-a07: ZEC->USDT->USDC->wNEAR; a08-a12: BTC->USDT->USDC->wNEAR->ZEC)
 * and no two agents want each other's token (pairs alone can't clear the 3-ring).
 */
export const AGENT_PLAN: { hold: string; want: string; usd: number }[] = [
  { hold: "ZEC", want: "USDC", usd: 3 },
  { hold: "USDC", want: "wNEAR", usd: 3 },
  { hold: "wNEAR", want: "ZEC", usd: 3 },
  { hold: "ZEC", want: "USDT", usd: 3 },
  { hold: "USDT", want: "USDC", usd: 3 },
  { hold: "USDC", want: "wNEAR", usd: 3 },
  { hold: "wNEAR", want: "ZEC", usd: 3 },
  { hold: "BTC", want: "USDT", usd: 3 },
  { hold: "USDT", want: "USDC", usd: 3 },
  { hold: "USDC", want: "wNEAR", usd: 3 },
  { hold: "wNEAR", want: "ZEC", usd: 3 },
  { hold: "ZEC", want: "BTC", usd: 3 },
];
