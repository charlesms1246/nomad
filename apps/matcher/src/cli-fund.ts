#!/usr/bin/env node
// make fund: top up each agent's demo inventory in the testnet Verifier and its board storage.
// Env: FUND_USD (override per-agent USD), SKIP_BOARD=1, AGENT_PREFIX (e.g. fx for fixture agents)
import { loadConfig } from "./config.js";
import { fundAgents } from "./fund.js";

fundAgents(loadConfig(), {
  usd: process.env.FUND_USD ? +process.env.FUND_USD : undefined,
  board: process.env.SKIP_BOARD !== "1",
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
