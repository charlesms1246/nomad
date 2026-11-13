import { describe, it, expect } from "vitest";
import { legCheck, type LegCheckInput } from "../src/legCheck.js";
import type { Offer, RingProposal } from "../src/protocol.js";

const W = "nep141:wnear.nomadswarm.testnet";
const U = "nep141:usdc.nomadswarm.testnet";
const Z = "nep141:zec.nomadswarm.testnet";
const NOW = 1_800_000_000_000;

const offers: Offer[] = [
  { id: "1", agent: "a01", give: W, giveMax: 1000n, want: U, rateNum: 3n, rateDen: 1n, expiresAtMs: NOW + 3_600_000 },
];

function proposal(over: Partial<RingProposal> = {}): RingProposal {
  return {
    ringId: "r1",
    legs: [
      { agent: "a01", offerId: "1", give: W, giveAmt: 100n, get: U, getAmt: 310n },
      { agent: "a02", offerId: "2", give: U, giveAmt: 310n, get: Z, getAmt: 5n },
      { agent: "a03", offerId: "3", give: Z, giveAmt: 5n, get: W, getAmt: 99n },
    ],
    matcherLeg: { token: W, amt: 1n },
    deadline: new Date(NOW + 60_000).toISOString(),
    proposalExpiresAtMs: NOW + 60_000,
    matcher: "m",
    verifierId: "intents.nomadswarm.testnet",
    salt: "00000000",
    ...over,
  };
}

const base = (p: RingProposal = proposal(), over: Partial<LegCheckInput> = {}): LegCheckInput => ({
  agent: "a01",
  proposal: p,
  offers,
  balances: { [W]: 1000n },
  committed: {},
  nowMs: NOW,
  expectedVerifier: "intents.nomadswarm.testnet",
  ...over,
});

const withLeg0 = (patch: object) => {
  const p = proposal();
  p.legs[0] = { ...p.legs[0]!, ...patch };
  return p;
};

describe("legCheck", () => {
  it("accepts a good leg", () => {
    expect(legCheck(base())).toEqual({ ok: true, leg: proposal().legs[0] });
  });
  it("rejects a wrong token", () => {
    expect(legCheck(base(withLeg0({ get: Z })))).toMatchObject({ ok: false, reason: "token pair differs from offer" });
  });
  it("rejects a rate below the limit", () => {
    expect(legCheck(base(withLeg0({ getAmt: 299n })))).toMatchObject({ ok: false, reason: "rate below limit" });
  });
  it("accepts exactly the limit rate", () => {
    const p = withLeg0({ getAmt: 300n });
    p.legs[1] = { ...p.legs[1]!, giveAmt: 300n };
    expect(legCheck(base(p)).ok).toBe(true);
  });
  it("rejects an expired deadline", () => {
    expect(legCheck(base(proposal({ deadline: new Date(NOW - 1).toISOString() })))).toMatchObject({ ok: false });
  });
  it("rejects a deadline too far ahead", () => {
    expect(legCheck(base(proposal({ deadline: new Date(NOW + 10 * 60_000).toISOString() })))).toMatchObject({
      ok: false,
      reason: "deadline too far ahead",
    });
  });
  it("rejects an amount above the offer", () => {
    expect(legCheck(base(withLeg0({ giveAmt: 1001n, getAmt: 99999n })))).toMatchObject({
      ok: false,
      reason: "gives more than giveMax",
    });
  });
  it("rejects insufficient balance", () => {
    expect(legCheck(base(undefined, { balances: { [W]: 50n } }))).toMatchObject({ ok: false, reason: "insufficient balance" });
  });
  it("allows over-commit up to 2x but not beyond", () => {
    expect(legCheck(base(undefined, { committed: { [W]: 1900n } })).ok).toBe(true);
    expect(legCheck(base(undefined, { committed: { [W]: 1901n } }))).toMatchObject({ reason: "over-commit limit" });
  });
  it("rejects a non-cycle", () => {
    const p = proposal();
    p.legs[2] = { ...p.legs[2]!, get: U };
    expect(legCheck(base(p))).toMatchObject({ ok: false, reason: "legs do not form a cycle" });
  });
  it("rejects a duplicate agent", () => {
    const p = proposal();
    p.legs[1] = { ...p.legs[1]!, agent: "a03" };
    expect(legCheck(base(p))).toMatchObject({ ok: false, reason: "duplicate agent in ring" });
  });
  it("rejects a wrong verifier", () => {
    expect(legCheck(base(proposal({ verifierId: "evil.testnet" })))).toMatchObject({ ok: false });
  });
  it("rejects an expired offer", () => {
    expect(legCheck(base(undefined, { nowMs: NOW + 3_600_001 })).ok).toBe(false);
  });
  it("rejects zero amounts", () => {
    expect(legCheck(base(withLeg0({ giveAmt: 0n })))).toMatchObject({ ok: false, reason: "non-positive amount" });
  });
});
