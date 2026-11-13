// Shared types for the Nomad bus (TECH_DOC §4, §6.2).
// Amounts travel as decimal strings on the wire and are bigint in memory.

export type TokenId = string;
export type AccountId = string;

export interface Offer {
  id: string;
  agent: AccountId;
  give: TokenId;
  giveMax: bigint;
  want: TokenId;
  /** Minimum `want` per `give`, in smallest units: rateNum / rateDen. */
  rateNum: bigint;
  rateDen: bigint;
  expiresAtMs: number;
}

export interface Leg {
  agent: AccountId;
  offerId: string;
  give: TokenId;
  giveAmt: bigint; // diff[give] = -giveAmt
  get: TokenId;
  getAmt: bigint; // diff[get] = +getAmt (already net of the verifier fee)
}

export interface RingProposal {
  ringId: string;
  legs: Leg[];
  matcherLeg: { token: TokenId; amt: bigint };
  /** ISO time: Intents deadline on every leg. */
  deadline: string;
  /** ms epoch: proposal expires (60 s after proposing). */
  proposalExpiresAtMs: number;
  matcher: AccountId;
  verifierId: AccountId;
  salt: string;
}

export type MultiPayload = {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
};

// ---- wire messages ----
export type WireLeg = Omit<Leg, "giveAmt" | "getAmt"> & { giveAmt: string; getAmt: string };
export type WireProposal = Omit<RingProposal, "legs" | "matcherLeg"> & {
  legs: WireLeg[];
  matcherLeg: { token: TokenId; amt: string };
};

export type BusMessage =
  | { type: "HELLO"; agent: AccountId; offers: WireOffer[] }
  | { type: "OFFERS"; agent: AccountId; offers: WireOffer[] }
  | { type: "PROPOSE"; to: AccountId; proposal: WireProposal }
  | { type: "SIGNED"; ringId: string; agent: AccountId; signed: MultiPayload }
  | { type: "DECLINE"; ringId: string; agent: AccountId; reason: string }
  | { type: "SETTLED"; ringId: string; txHash: string; blockHeight?: number }
  | { type: "FAILED"; ringId: string; error: string };

export type WireOffer = Omit<Offer, "giveMax" | "rateNum" | "rateDen"> & {
  giveMax: string;
  rateNum: string;
  rateDen: string;
};

export const toWireLeg = (l: Leg): WireLeg => ({ ...l, giveAmt: l.giveAmt.toString(), getAmt: l.getAmt.toString() });
export const fromWireLeg = (l: WireLeg): Leg => ({ ...l, giveAmt: BigInt(l.giveAmt), getAmt: BigInt(l.getAmt) });

export const toWireProposal = (p: RingProposal): WireProposal => ({
  ...p,
  legs: p.legs.map(toWireLeg),
  matcherLeg: { token: p.matcherLeg.token, amt: p.matcherLeg.amt.toString() },
});
export const fromWireProposal = (p: WireProposal): RingProposal => ({
  ...p,
  legs: p.legs.map(fromWireLeg),
  matcherLeg: { token: p.matcherLeg.token, amt: BigInt(p.matcherLeg.amt) },
});

export const toWireOffer = (o: Offer): WireOffer => ({
  ...o,
  giveMax: o.giveMax.toString(),
  rateNum: o.rateNum.toString(),
  rateDen: o.rateDen.toString(),
});
export const fromWireOffer = (o: WireOffer): Offer => ({
  ...o,
  giveMax: BigInt(o.giveMax),
  rateNum: BigInt(o.rateNum),
  rateDen: BigInt(o.rateDen),
});

/** The exact token_diff an agent signs for its leg. */
export const legDiff = (l: Leg): Record<TokenId, string> => ({
  [l.give]: (-l.giveAmt).toString(),
  [l.get]: l.getAmt.toString(),
});
