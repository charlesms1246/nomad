// Agent runtime: holds a strategy, keeps offers live, and answers ring proposals.
// Transport-agnostic: the same class runs in-process (sim) and behind the WebSocket bus (live).

import { legCheck } from "./legCheck.js";
import { runStrategy, type StrategyName, type TokenInfo } from "./strategies.js";
import { legDiff, type Offer, type RingProposal, type TokenId, type MultiPayload } from "./protocol.js";

/** Signs one token_diff for this agent. Live: @nomad/intents signTokenDiff. Sim: same signer, model verifier. */
export type LegSigner = (args: {
  diff: Record<TokenId, string>;
  deadline: Date;
  salt: string;
  verifierId: string;
  memo?: string;
}) => MultiPayload;

/** Reads this agent's verifier balances. Live: mt_balance_of. Sim: verifier model. */
export type BalanceReader = (tokens: TokenId[]) => Promise<Record<TokenId, bigint>>;

export interface AgentConfig {
  id: string;
  strategy: StrategyName;
  margin: number;
  target?: TokenId;
  weights?: Record<TokenId, number>;
  sizeFrac?: number;
  ttlMs?: number;
  verifierId: string;
  /** Limit-price override hook (LLM=1 stretch): returns a margin given context. Never signs. */
  marginAdvisor?: (ctx: { holdings: Record<TokenId, bigint>; tokens: TokenInfo[] }) => Promise<number>;
}

export type ProposalAnswer =
  | { type: "SIGNED"; ringId: string; agent: string; signed: MultiPayload }
  | { type: "DECLINE"; ringId: string; agent: string; reason: string };

export class AgentRuntime {
  offers: Offer[] = [];
  balances: Record<TokenId, bigint> = {};
  /** ringId -> what this agent promised in that ring (released on SETTLED/FAILED/expiry). */
  pending = new Map<string, { token: TokenId; amt: bigint; expiresAtMs: number }>();
  unmatchedRounds = 0;
  private seq = 0;

  constructor(
    public cfg: AgentConfig,
    private sign: LegSigner,
    private readBalances: BalanceReader,
    private rng: () => number,
  ) {}

  get id() {
    return this.cfg.id;
  }

  async refresh(tokens: TokenInfo[], nowMs: number): Promise<Offer[]> {
    this.balances = await this.readBalances(tokens.map((t) => t.id));
    this.gcPending(nowMs);
    const margin = this.cfg.marginAdvisor
      ? clampMargin(await this.cfg.marginAdvisor({ holdings: this.balances, tokens }))
      : this.cfg.margin;
    // Keep live offers until they expire; replace only when none are live (one per pair, RULES §2.2).
    const live = this.offers.filter((o) => o.expiresAtMs > nowMs + 5_000);
    if (live.length > 0) {
      this.offers = live;
      return live;
    }
    this.offers = runStrategy(this.cfg.strategy, {
      agent: this.id,
      holdings: this.available(),
      tokens,
      margin,
      rng: this.rng,
      nowMs,
      ttlMs: this.cfg.ttlMs ?? 10 * 60_000,
      target: this.cfg.target,
      weights: this.cfg.weights,
      sizeFrac: this.cfg.sizeFrac,
      nextId: () => `${this.id}:${nowMs}:${this.seq++}`,
    });
    return this.offers;
  }

  /** Holdings minus amounts promised to pending rings (strategy sizes from what is free). */
  available(): Record<TokenId, bigint> {
    const out = { ...this.balances };
    for (const p of this.pending.values()) out[p.token] = (out[p.token] ?? 0n) - p.amt > 0n ? (out[p.token] ?? 0n) - p.amt : 0n;
    return out;
  }

  committed(): Record<TokenId, bigint> {
    const c: Record<TokenId, bigint> = {};
    for (const p of this.pending.values()) c[p.token] = (c[p.token] ?? 0n) + p.amt;
    return c;
  }

  onProposal(p: RingProposal, nowMs: number): ProposalAnswer {
    const r = legCheck({
      agent: this.id,
      proposal: p,
      offers: this.offers,
      balances: this.balances,
      committed: this.committed(),
      nowMs,
      expectedVerifier: this.cfg.verifierId,
    });
    if (!r.ok) return { type: "DECLINE", ringId: p.ringId, agent: this.id, reason: r.reason };
    const signed = this.sign({
      diff: legDiff(r.leg),
      deadline: new Date(p.deadline),
      salt: p.salt,
      verifierId: p.verifierId,
      memo: `nomad:${p.ringId.slice(0, 16)}`,
    });
    this.pending.set(p.ringId, { token: r.leg.give, amt: r.leg.giveAmt, expiresAtMs: Date.parse(p.deadline) });
    return { type: "SIGNED", ringId: p.ringId, agent: this.id, signed };
  }

  onSettled(ringId: string, offerId?: string, gave?: bigint) {
    const p = this.pending.get(ringId);
    this.pending.delete(ringId);
    // Shrink the offer that was used; drop it when exhausted.
    if (offerId && gave !== undefined) {
      this.offers = this.offers
        .map((o) => (o.id === offerId ? { ...o, giveMax: o.giveMax - gave } : o))
        .filter((o) => o.giveMax > 0n);
    }
    if (p && this.balances[p.token] !== undefined) this.balances[p.token] = this.balances[p.token]! - p.amt;
    this.unmatchedRounds = 0;
  }

  onFailed(ringId: string) {
    this.pending.delete(ringId);
  }

  private gcPending(nowMs: number) {
    for (const [k, v] of this.pending) if (v.expiresAtMs < nowMs) this.pending.delete(k);
  }
}

const clampMargin = (m: number) => (Number.isFinite(m) ? Math.min(0.05, Math.max(0, m)) : 0.01);
