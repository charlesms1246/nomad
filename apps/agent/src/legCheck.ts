// What an agent checks before it signs its leg of a ring (TECH_DOC §6.3, RULES.md §4.1).
// Pure and deterministic: an LLM may pick prices, but only this code decides whether to sign.

import type { Offer, RingProposal, Leg, TokenId } from "./protocol.js";

export const MAX_DEADLINE_AHEAD_MS = 120_000;
export const OVERCOMMIT_FACTOR = 2n;

export interface LegCheckInput {
  agent: string;
  proposal: RingProposal;
  offers: Offer[];
  /** Verifier balance of each token for this agent. */
  balances: Record<TokenId, bigint>;
  /** Amount of each token already promised to other pending (unsettled) rings. */
  committed: Record<TokenId, bigint>;
  nowMs: number;
  expectedVerifier: string;
}

export type LegCheckResult = { ok: true; leg: Leg } | { ok: false; reason: string };

export function legCheck(i: LegCheckInput): LegCheckResult {
  const { proposal: p } = i;
  if (p.verifierId !== i.expectedVerifier) return no(`wrong verifier ${p.verifierId}`);

  const mine = p.legs.filter((l) => l.agent === i.agent);
  if (mine.length !== 1) return no(mine.length === 0 ? "no leg for this agent" : "agent appears twice in ring");
  const leg = mine[0]!;

  if (p.legs.length < 2 || p.legs.length > 5) return no(`ring length ${p.legs.length} out of range`);
  const agents = new Set(p.legs.map((l) => l.agent));
  if (agents.size !== p.legs.length) return no("duplicate agent in ring");

  const offer = i.offers.find((o) => o.id === leg.offerId);
  if (!offer) return no(`unknown offer ${leg.offerId}`);
  if (offer.agent !== i.agent) return no("offer belongs to another agent");
  if (offer.expiresAtMs <= i.nowMs) return no("offer expired");

  // 1. token pair matches the offer
  if (leg.give !== offer.give || leg.get !== offer.want) return no("token pair differs from offer");
  if (leg.give === leg.get) return no("give and get are the same token");

  // amounts positive
  if (leg.giveAmt <= 0n || leg.getAmt <= 0n) return no("non-positive amount");

  // 1b. never give more than the offer allows (minus what is already promised elsewhere, with over-commit)
  if (leg.giveAmt > offer.giveMax) return no("gives more than giveMax");

  // 2. rate at or above the limit: getAmt / giveAmt >= rateNum / rateDen
  if (leg.getAmt * offer.rateDen < leg.giveAmt * offer.rateNum) return no("rate below limit");

  // 3. deadlines
  const deadlineMs = Date.parse(p.deadline);
  if (!Number.isFinite(deadlineMs)) return no("bad deadline");
  if (deadlineMs <= i.nowMs) return no("deadline in the past");
  if (deadlineMs > i.nowMs + MAX_DEADLINE_AHEAD_MS) return no("deadline too far ahead");
  if (p.proposalExpiresAtMs <= i.nowMs) return no("proposal expired");

  // 4. balance (over-commit allowed up to 2x; overlapping rings fail atomically)
  const bal = i.balances[leg.give] ?? 0n;
  if (bal < leg.giveAmt) return no("insufficient balance");
  const already = i.committed[leg.give] ?? 0n;
  if (already + leg.giveAmt > bal * OVERCOMMIT_FACTOR) return no("over-commit limit");

  // ring must be a proper cycle: each leg's get is the next leg's give
  for (let k = 0; k < p.legs.length; k++) {
    const a = p.legs[k]!;
    const b = p.legs[(k + 1) % p.legs.length]!;
    if (a.get !== b.give) return no("legs do not form a cycle");
  }

  // matcher leg must be non-negative (it is a positive-only diff)
  if (p.matcherLeg.amt < 0n) return no("negative matcher leg");

  return { ok: true, leg };
}

const no = (reason: string): LegCheckResult => ({ ok: false, reason });
