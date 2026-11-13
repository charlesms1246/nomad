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

export const agentIds = (n: number, parent: string) =>
  Array.from({ length: n }, (_, i) => `a${String(i + 1).padStart(2, "0")}.${parent}`);

export function readKey(accountId: string, kind: "intents" | "board") {
  const f = path.join(keysDir(), `${accountId}.${kind}.json`);
  const k = JSON.parse(fs.readFileSync(f, "utf8"));
  return { signerId: k.account_id as string, secretKey: k.private_key as string, publicKey: k.public_key as string };
}
