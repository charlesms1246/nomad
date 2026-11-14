// Top up agents' Verifier inventory to their plan (ft_transfer_call from the token owner with
// msg = agent id, BUILD_PLAN C6) and prepay board storage. Idempotent: only agents below half
// their target are topped up. Used by `make fund` and by live mode's AUTO_FUND.
import { IntentsClient, NearRpc, ONE_NEAR, signerFor, TESTNET_RPC } from "@nomad/intents";
import { BoardClient } from "@nomad/agent";
import { agentIds, AGENT_PLAN, type NomadConfig } from "./config.js";
import { SIM_TOKENS } from "./sim.js";

export async function fundAgents(
  cfg: NomadConfig,
  opts: { usd?: number; board?: boolean; prefix?: string; log?: (m: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
  const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
  const board = new BoardClient(rpc, cfg.boardId!);
  const owner = signerFor(cfg.parent);
  let deposits = 0;
  for (const [i, id] of agentIds(AGENT_PLAN.length, cfg.parent, opts.prefix).entries()) {
    const plan = AGENT_PLAN[i]!;
    const t = cfg.tokens.find((x) => x.symbol === plan.hold)!;
    const price = SIM_TOKENS.find((s) => s.symbol === plan.hold)!.priceUsd;
    const usd = opts.usd ?? plan.usd;
    const target = BigInt(Math.floor((usd / price) * 10 ** Math.min(t.decimals, 15))) * 10n ** BigInt(Math.max(0, t.decimals - 15));
    const have = await intents.mtBalanceOf(id, t.id);
    if (have < target / 2n) {
      const r = await intents.deposit(owner, t.contract, target - have, id);
      deposits++;
      log(`${id}: deposit ${target - have} ${plan.hold} -> ${r.ok ? r.txHash : "FAILED " + r.error}`);
    } else log(`${id}: has ${have} ${plan.hold}`);
    if (opts.board !== false) {
      const bal = BigInt(await rpc.view<string>(cfg.boardId!, "storage_balance_of", { account_id: id }).catch(() => "0"));
      if (bal < ONE_NEAR / 50n) {
        const r = await board.storageDeposit(owner, id, ONE_NEAR / 20n);
        log(`${id}: board storage 0.05 NEAR -> ${r.ok ? r.txHash : "FAILED " + r.error}`);
      }
    }
  }
  return deposits;
}
