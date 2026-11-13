#!/usr/bin/env node
// make fund: deposit each agent's demo inventory into the testnet Verifier (ft_transfer_call from the
// token owner with msg = agent id, BUILD_PLAN C6) and prepay each agent's board storage.
// Idempotent: tops up only agents below their target.
import { IntentsClient, NearRpc, ONE_NEAR, signerFor, TESTNET_RPC } from "@nomad/intents";
import { BoardClient } from "@nomad/agent";
import { loadConfig, agentIds, AGENT_PLAN } from "./config.js";
import { SIM_TOKENS } from "./sim.js";

async function main() {
  const cfg = loadConfig();
  const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
  const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
  const board = new BoardClient(rpc, cfg.boardId!);
  const owner = signerFor(cfg.parent);
  const ids = agentIds(AGENT_PLAN.length, cfg.parent);
  for (const [i, id] of ids.entries()) {
    const plan = AGENT_PLAN[i]!;
    const t = cfg.tokens.find((x) => x.symbol === plan.hold)!;
    const price = SIM_TOKENS.find((s) => s.symbol === plan.hold)!.priceUsd;
    const target = BigInt(Math.floor((plan.usd / price) * 10 ** Math.min(t.decimals, 15))) * 10n ** BigInt(Math.max(0, t.decimals - 15));
    const have = await intents.mtBalanceOf(id, t.id);
    if (have < target / 2n) {
      const r = await intents.deposit(owner, t.contract, target - have, id);
      console.log(`${id}: deposit ${target - have} ${plan.hold} -> ${r.ok ? r.txHash : "FAILED " + r.error}`);
    } else console.log(`${id}: has ${have} ${plan.hold}`);
    if (process.env.SKIP_BOARD !== "1") {
      const bal = BigInt(await rpc.view<string>(cfg.boardId!, "storage_balance_of", { account_id: id }).catch(() => "0"));
      if (bal < ONE_NEAR / 50n) {
        const r = await board.storageDeposit(owner, id, ONE_NEAR / 20n);
        console.log(`${id}: board storage 0.05 NEAR -> ${r.ok ? r.txHash : "FAILED " + r.error}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
