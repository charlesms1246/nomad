// Client for the offer board contract (contracts/board, RULES.md).
// Agents post with a function-call key limited to post_offer/cancel_offer (no deposit:
// storage is drawn from a balance prepaid once with storage_deposit).
import { NearRpc, TGAS, type Signer } from "@nomad/intents";
import type { Offer } from "./protocol.js";

export interface BoardOffer {
  id: number;
  agent: string;
  give: string;
  give_max: string;
  want: string;
  rate_num: string;
  rate_den: string;
  expires_at_ms: number;
  created_at_ms: number;
}

export const fromBoard = (o: BoardOffer): Offer => ({
  id: String(o.id),
  agent: o.agent,
  give: o.give,
  giveMax: BigInt(o.give_max),
  want: o.want,
  rateNum: BigInt(o.rate_num),
  rateDen: BigInt(o.rate_den),
  expiresAtMs: o.expires_at_ms,
});

export class BoardClient {
  constructor(
    readonly rpc: NearRpc,
    readonly boardId: string,
  ) {}

  async offers(limit = 500): Promise<Offer[]> {
    const out: Offer[] = [];
    let from = 0;
    for (;;) {
      const page = await this.rpc.view<BoardOffer[]>(this.boardId, "offers", { from, limit: 100 });
      out.push(...page.map(fromBoard));
      if (page.length < 100 || out.length >= limit) break;
      from = page[page.length - 1]!.id + 1;
    }
    return out;
  }

  async offersByAgent(agent: string): Promise<Offer[]> {
    return (await this.rpc.view<BoardOffer[]>(this.boardId, "offers_by_agent", { agent })).map(fromBoard);
  }

  /** Posts (or replaces) an offer; returns the board's id for it. `deposit` 0 uses the prepaid balance. */
  async postOffer(signer: Signer, o: Omit<Offer, "id" | "agent" | "expiresAtMs">, ttlMs: number, deposit = 0n): Promise<string> {
    const r = await this.rpc.sendTx(signer, this.boardId, [
      {
        type: "FunctionCall",
        methodName: "post_offer",
        args: {
          give: o.give,
          give_max: o.giveMax.toString(),
          want: o.want,
          rate_num: o.rateNum.toString(),
          rate_den: o.rateDen.toString(),
          ttl_ms: Math.min(ttlMs, 3_600_000),
        },
        gas: 30n * TGAS,
        deposit,
      },
    ]);
    if (!r.ok) throw new Error(`post_offer failed: ${r.error}`);
    return String(JSON.parse(r.returnValue ?? "null"));
  }

  async cancelOffer(signer: Signer, id: string) {
    return this.rpc.sendTx(signer, this.boardId, [
      { type: "FunctionCall", methodName: "cancel_offer", args: { id: Number(id) }, gas: 30n * TGAS, deposit: 0n },
    ]);
  }

  async recordRing(signer: Signer, ringId: string, offerIds: string[], txHash: string) {
    return this.rpc.sendTx(signer, this.boardId, [
      {
        type: "FunctionCall",
        methodName: "record_ring",
        args: { ring_id: ringId, offer_ids: offerIds.map(Number), tx_hash: txHash },
        gas: 30n * TGAS,
        deposit: 0n,
      },
    ]);
  }

  async storageDeposit(payer: Signer, accountId: string, amountYocto: bigint) {
    return this.rpc.sendTx(payer, this.boardId, [
      { type: "FunctionCall", methodName: "storage_deposit", args: { account_id: accountId }, gas: 30n * TGAS, deposit: amountYocto },
    ]);
  }
}
