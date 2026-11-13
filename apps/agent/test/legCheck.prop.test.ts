// Property tests for the agent's signing guard (TECH_DOC §16.2, RULES.md §4.1-4.2).
// Random (often adversarial) ring proposals go through legCheck and through AgentRuntime.onProposal,
// the real signing path, which signs a NEP-413 token_diff with a real ed25519 key. Whatever the
// proposal, a signed leg must never:
//   - give below the offer's limit rate,
//   - give more than giveMax (or past the 2x over-commit cap across pending rings),
//   - contain any token other than the offer's give/want pair, or any extra intent,
//   - carry a deadline past the offer's expiry or more than 120 s ahead,
//   - be signed for another verifier or by another account.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromSeed, signTokenDiff, verifyPayload } from "@nomad/intents";
import { legCheck, MAX_DEADLINE_AHEAD_MS, OVERCOMMIT_FACTOR } from "../src/legCheck.js";
import { AgentRuntime } from "../src/runtime.js";
import type { Leg, Offer, RingProposal } from "../src/protocol.js";

const VERIFIER = "intents.nomadswarm.testnet";
const ME = "a01.nomadswarm.testnet";
const OTHERS = ["a02.nomadswarm.testnet", "a03.nomadswarm.testnet", "a04.nomadswarm.testnet", "a05.nomadswarm.testnet", "a06.nomadswarm.testnet"];
const OWN = ["nep141:wnear.nomadswarm.testnet", "nep141:usdc.nomadswarm.testnet", "nep141:zec.nomadswarm.testnet"];
const FOREIGN = ["nep141:evil.testnet", "nep141:usdt.nomadswarm.testnet"];
const ALL = [...OWN, ...FOREIGN];
const NOW = 1_800_000_000_000;
const KEY = fromSeed(new Uint8Array(32).fill(9));

// ---------- arbitraries ----------
/** `rare` with probability ~1/n, else `usual`. */
const mostly = <T>(usual: fc.Arbitrary<T>, rare: fc.Arbitrary<T>, n = 8) => fc.oneof({ weight: n - 1, arbitrary: usual }, { weight: 1, arbitrary: rare });
const amount = fc.bigInt({ min: 1n, max: 10n ** 12n });
const offerArb = (id: string) =>
  fc
    .record({
      pair: fc.constantFrom(...OWN.flatMap((g) => OWN.filter((w) => w !== g).map((w) => [g, w] as const))),
      giveMax: amount,
      rateNum: fc.bigInt({ min: 1n, max: 10n ** 6n }),
      rateDen: fc.bigInt({ min: 1n, max: 10n ** 6n }),
      ttl: mostly(fc.integer({ min: 120_000, max: 3_600_000 }), fc.integer({ min: -10_000, max: 120_000 }), 4),
    })
    .map((o): Offer => ({ id, agent: ME, give: o.pair[0], want: o.pair[1], giveMax: o.giveMax, rateNum: o.rateNum, rateDen: o.rateDen, expiresAtMs: NOW + o.ttl }));
const offersArb = fc.array(fc.nat(), { minLength: 1, maxLength: 3 }).chain((xs) => fc.tuple(...xs.map((_, i) => offerArb(`o${i}`))));

/**
 * A proposal built around one of my offers, then perturbed: the amounts are pushed around the limit
 * and giveMax, tokens may be swapped for foreign ones, deadlines/verifier/agents may be wrong, and
 * the ring may or may not close. A good share is fully valid, so the accept path is exercised.
 */
const proposalArb = (offers: Offer[]) =>
  fc
    .record({
      oi: fc.nat({ max: offers.length - 1 }),
      k: mostly(fc.integer({ min: 2, max: 5 }), fc.constantFrom(1, 6)),
      giveScale: mostly(fc.double({ min: 0.001, max: 1, noNaN: true }), fc.double({ min: 0, max: 2.2, noNaN: true }), 3),
      rateSlack: fc.bigInt({ min: -3n, max: 50n }),
      swapGive: mostly(fc.constant(null), fc.constantFrom(...ALL)),
      swapGet: mostly(fc.constant(null), fc.constantFrom(...ALL)),
      badOffer: mostly(fc.constant(false), fc.constant(true), 12),
      meTwice: mostly(fc.constant(false), fc.constant(true), 12),
      breakCycle: mostly(fc.constant(false), fc.constant(true), 10),
      deadlineAhead: mostly(fc.integer({ min: 1, max: 120_000 }), fc.integer({ min: -5_000, max: 200_000 }), 4),
      proposalAhead: fc.integer({ min: -5_000, max: 60_000 }),
      verifier: mostly(fc.constant(VERIFIER), fc.constantFrom("intents.near", "evil.testnet")),
      matcherAmt: fc.bigInt({ min: -2n, max: 1000n }),
    })
    .map((r): RingProposal => {
      const o = offers[r.oi]!;
      const giveAmt = BigInt(Math.floor(Number(o.giveMax) * r.giveScale));
      // minimal acceptable get = ceil(giveAmt * num / den), then nudge by rateSlack
      const minGet = (giveAmt * o.rateNum + o.rateDen - 1n) / o.rateDen;
      const getAmt = minGet + r.rateSlack;
      const give = r.swapGive ?? o.give;
      const get = r.swapGet ?? o.want;
      const mine: Leg = { agent: ME, offerId: r.badOffer ? "nope" : o.id, give, giveAmt, get, getAmt };
      // other legs carry `get` round the ring back to `give`
      const legs: Leg[] = [mine];
      let cur = get;
      for (let j = 1; j < r.k; j++) {
        const next = j === r.k - 1 ? give : ALL[(ALL.indexOf(cur) + j) % ALL.length]!;
        legs.push({ agent: r.meTwice && j === 1 ? ME : OTHERS[j - 1]!, offerId: `x${j}`, give: cur, giveAmt: 10n, get: next, getAmt: 10n });
        cur = next;
      }
      if (r.breakCycle && legs.length > 1) legs[legs.length - 1] = { ...legs[legs.length - 1]!, get: FOREIGN[0]! };
      return {
        ringId: `r${Math.random().toString(36).slice(2)}`,
        legs,
        matcherLeg: { token: give, amt: r.matcherAmt },
        deadline: new Date(NOW + r.deadlineAhead).toISOString(),
        proposalExpiresAtMs: NOW + r.proposalAhead,
        matcher: "intents-matcher.nomadswarm.testnet",
        verifierId: r.verifier,
        salt: "7ca1a9f9",
      };
    });

const balancesArb = fc.record(Object.fromEntries(ALL.map((t) => [t, mostly(fc.bigInt({ min: 10n ** 12n, max: 10n ** 13n }), fc.bigInt({ min: 0n, max: 10n ** 13n }), 3)])));

// ---------- the invariant every signed leg must satisfy ----------
function assertSafe(leg: Leg, p: RingProposal, offers: Offer[]) {
  const o = offers.find((x) => x.id === leg.offerId);
  expect(o, "signed against one of my offers").toBeDefined();
  expect(leg.agent).toBe(ME);
  expect(o!.agent).toBe(ME);
  expect(leg.give).toBe(o!.give);
  expect(leg.get).toBe(o!.want);
  expect(leg.giveAmt > 0n && leg.getAmt > 0n).toBe(true);
  expect(leg.giveAmt <= o!.giveMax, "never above giveMax").toBe(true);
  expect(leg.getAmt * o!.rateDen >= leg.giveAmt * o!.rateNum, "never below the limit rate").toBe(true);
  const dl = Date.parse(p.deadline);
  expect(dl > NOW && dl <= NOW + MAX_DEADLINE_AHEAD_MS && dl <= o!.expiresAtMs).toBe(true);
  expect(o!.expiresAtMs > NOW).toBe(true);
  expect(p.verifierId).toBe(VERIFIER);
}

describe("legCheck properties", () => {
  it("an accepted leg is always within the offer: pair, giveMax, limit rate, deadline, verifier", () => {
    let accepted = 0;
    fc.assert(
      fc.property(offersArb.chain((offers) => fc.tuple(fc.constant(offers), proposalArb(offers), balancesArb)), ([offers, p, balances]) => {
        const r = legCheck({ agent: ME, proposal: p, offers, balances, committed: {}, nowMs: NOW, expectedVerifier: VERIFIER });
        if (!r.ok) return;
        accepted++;
        assertSafe(r.leg, p, offers);
        expect((balances[r.leg.give] ?? 0n) >= r.leg.giveAmt).toBe(true);
      }),
      { numRuns: 3000 },
    );
    // the generator must actually reach the accept path, or the property is vacuous
    expect(accepted).toBeGreaterThan(30);
  });

  it("valid-by-construction proposals are accepted (the guard is not trivially 'reject all')", () => {
    fc.assert(
      fc.property(offerArb("o0"), fc.double({ min: 0.01, max: 1, noNaN: true }), fc.bigInt({ min: 0n, max: 100n }), (o, scale, slack) => {
        const offer = { ...o, expiresAtMs: NOW + 3_600_000 };
        const giveAmt = BigInt(Math.max(1, Math.floor(Number(offer.giveMax) * scale)));
        const getAmt = (giveAmt * offer.rateNum + offer.rateDen - 1n) / offer.rateDen + slack;
        const other = OWN.find((t) => t !== offer.give && t !== offer.want)!;
        const p: RingProposal = {
          ringId: "ok",
          legs: [
            { agent: ME, offerId: "o0", give: offer.give, giveAmt, get: offer.want, getAmt },
            { agent: OTHERS[0]!, offerId: "x", give: offer.want, giveAmt: 5n, get: other, getAmt: 5n },
            { agent: OTHERS[1]!, offerId: "y", give: other, giveAmt: 5n, get: offer.give, getAmt: 5n },
          ],
          matcherLeg: { token: offer.give, amt: 1n },
          deadline: new Date(NOW + 60_000).toISOString(),
          proposalExpiresAtMs: NOW + 60_000,
          matcher: "m",
          verifierId: VERIFIER,
          salt: "7ca1a9f9",
        };
        const r = legCheck({ agent: ME, proposal: p, offers: [offer], balances: { [offer.give]: offer.giveMax }, committed: {}, nowMs: NOW, expectedVerifier: VERIFIER });
        expect(r.ok).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("AgentRuntime.onProposal properties (the real signing path)", () => {
  it("over a stream of random proposals, every SIGNED payload is a verifiable diff of exactly the offer's two tokens within limits, and pending commitments stay <= 2x balance", async () => {
    let signedCount = 0;
    await fc.assert(
      fc.asyncProperty(
        offersArb.chain((offers) => fc.tuple(fc.constant(offers), fc.array(proposalArb(offers), { minLength: 1, maxLength: 12 }), balancesArb)),
        async ([offers, proposals, balances]) => {
          const signer = (a: Parameters<ConstructorParameters<typeof AgentRuntime>[1]>[0]) =>
            signTokenDiff({ signerId: ME, secretKey: KEY.secretKeyStr, verifierId: a.verifierId, salt: a.salt, deadline: a.deadline, diff: a.diff, memo: a.memo, nonce: a.nonce });
          const rt = new AgentRuntime({ id: ME, strategy: "random", margin: 0, verifierId: VERIFIER }, signer, async () => balances, () => 0.5);
          rt.offers = offers;
          rt.balances = balances;
          for (const p of proposals) {
            const ans = rt.onProposal(p, NOW);
            if (ans.type !== "SIGNED") continue;
            signedCount++;
            const s = ans.signed;
            expect(verifyPayload(s as any)).toBe(true);
            expect(s.payload.recipient).toBe(VERIFIER);
            const msg = JSON.parse(s.payload.message);
            expect(msg.signer_id).toBe(ME);
            expect(msg.intents).toHaveLength(1);
            expect(msg.intents[0].intent).toBe("token_diff");
            const diff: Record<string, string> = msg.intents[0].diff;
            const mine = p.legs.find((l) => l.agent === ME)!;
            const offer = offers.find((o) => o.id === mine.offerId)!;
            // exactly the offer's pair, nothing else
            expect(Object.keys(diff).sort()).toEqual([offer.give, offer.want].sort());
            const gave = -BigInt(diff[offer.give]!), got = BigInt(diff[offer.want]!);
            assertSafe({ ...mine, giveAmt: gave, getAmt: got }, p, offers);
            expect(Date.parse(msg.deadline)).toBe(Date.parse(p.deadline));
          }
          // over-commit cap across everything still pending
          for (const [t, c] of Object.entries(rt.committed())) expect(c <= (balances[t] ?? 0n) * OVERCOMMIT_FACTOR).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
    expect(signedCount).toBeGreaterThan(20);
  });

  it("with a tight balance, repeated valid proposals never commit more than 2x the balance", () => {
    let declinedForCap = 0;
    fc.assert(
      fc.property(offerArb("o0"), fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), { minLength: 2, maxLength: 15 }), (o, scales) => {
        const offer = { ...o, expiresAtMs: NOW + 3_600_000 };
        const bal = offer.giveMax; // the agent holds exactly one offer's worth
        const rt = new AgentRuntime({ id: ME, strategy: "random", margin: 0, verifierId: VERIFIER }, (a) => signTokenDiff({ signerId: ME, secretKey: KEY.secretKeyStr, verifierId: a.verifierId, salt: a.salt, deadline: a.deadline, diff: a.diff, nonce: a.nonce }), async () => ({}), () => 0.5);
        rt.offers = [offer];
        rt.balances = { [offer.give]: bal };
        const other = OWN.find((t) => t !== offer.give && t !== offer.want)!;
        scales.forEach((sc, j) => {
          const giveAmt = BigInt(Math.max(1, Math.floor(Number(offer.giveMax) * sc)));
          const getAmt = (giveAmt * offer.rateNum + offer.rateDen - 1n) / offer.rateDen;
          const ans = rt.onProposal(
            {
              ringId: `r${j}`,
              legs: [
                { agent: ME, offerId: "o0", give: offer.give, giveAmt, get: offer.want, getAmt },
                { agent: OTHERS[0]!, offerId: "x", give: offer.want, giveAmt: 5n, get: other, getAmt: 5n },
                { agent: OTHERS[1]!, offerId: "y", give: other, giveAmt: 5n, get: offer.give, getAmt: 5n },
              ],
              matcherLeg: { token: offer.give, amt: 0n },
              deadline: new Date(NOW + 60_000).toISOString(),
              proposalExpiresAtMs: NOW + 60_000,
              matcher: "m",
              verifierId: VERIFIER,
              salt: "7ca1a9f9",
            },
            NOW,
          );
          if (ans.type === "DECLINE" && ans.reason === "over-commit limit") declinedForCap++;
          const c = rt.committed()[offer.give] ?? 0n;
          expect(c <= bal * OVERCOMMIT_FACTOR, `committed ${c} > 2 x ${bal}`).toBe(true);
        });
      }),
      { numRuns: 500 },
    );
    expect(declinedForCap).toBeGreaterThan(10);
  });
});
