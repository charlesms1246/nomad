import { describe, expect, it } from 'vitest';
import { buildNonce, implicitAccountId, randomKeyPair, signIntents, signTokenDiff } from '@nomad/intents';
import { VerifierModel } from '../src/index.js';

const V = 'intents.nomadswarm.testnet';
const SALT = '7ca1a9f9';
const W = 'nep141:wnear.nomadswarm.testnet', U = 'nep141:usdc.nomadswarm.testnet', T = 'nep141:usdt.nomadswarm.testnet';
const FEES = 'fees.nomadswarm.testnet';

const agent = () => {
  const kp = randomKeyPair();
  return { id: implicitAccountId(kp.publicKey), sk: kp.secretKeyStr, pk: kp.publicKeyStr };
};
const model = () => new VerifierModel({ verifierId: V, feePips: 1, feeCollector: FEES, validSalts: [SALT] });
const later = () => new Date(Date.now() + 120_000);
const leg = (a: { id: string; sk: string }, diff: Record<string, bigint>, o: { salt?: string; deadline?: Date; nonce?: Uint8Array; verifier?: string } = {}) =>
  signTokenDiff({
    signerId: a.id, secretKey: a.sk, verifierId: o.verifier ?? V, salt: o.salt ?? SALT, deadline: o.deadline ?? later(), nonce: o.nonce,
    diff: Object.fromEntries(Object.entries(diff).map(([t, v]) => [t, v.toString()])),
  });

describe('VerifierModel (facts measured in K1/K2/K5 on our testnet Verifier)', () => {
  it('settles a fee-correct 3-ring and pays 1 unit of fee per token (K1)', () => {
    const m = model();
    const [a, b, c] = [agent(), agent(), agent()];
    m.deposit(a.id, W, 1_000_000n); m.deposit(b.id, U, 1_000_000n); m.deposit(c.id, T, 1_000_000n);
    const r = m.execute([leg(a, { [W]: -1_000_000n, [U]: 999_999n }), leg(b, { [U]: -1_000_000n, [T]: 999_999n }), leg(c, { [T]: -1_000_000n, [W]: 999_999n })]);
    expect(r.ok).toBe(true);
    expect(r.intentsExecuted).toHaveLength(3);
    expect(r.feesCollected).toEqual({ [W]: 1n, [U]: 1n, [T]: 1n });
    expect(m.balanceOf(a.id, U)).toBe(999_999n);
    expect(m.balanceOf(FEES, T)).toBe(1n);
  });

  it('rejects the naive zero-sum swap with unmatched deltas {W:1,U:1} (K5)', () => {
    const m = model();
    const [a, b] = [agent(), agent()];
    m.deposit(a.id, W, 1000n); m.deposit(b.id, U, 1000n);
    const r = m.simulate([leg(a, { [W]: -1000n, [U]: 1000n }), leg(b, { [U]: -1000n, [W]: 1000n })]);
    expect(r.ok).toBe(false);
    expect(r.invariantViolated).toEqual({ error: 'unmatched_deltas', unmatched_deltas: { [W]: '1', [U]: '1' } });
  });

  it('accepts a positive-only matcher leg and rejects an inflated one (K2)', () => {
    const m = model();
    const [a, b, mt] = [agent(), agent(), agent()];
    m.deposit(a.id, W, 1000n); m.deposit(b.id, U, 1000n);
    const legs = [leg(a, { [W]: -1000n, [U]: 999n }), leg(b, { [U]: -1000n, [W]: 992n })];
    expect(m.simulate([...legs, leg(mt, { [W]: 7n })]).ok).toBe(true);
    const bad = m.simulate([...legs, leg(mt, { [W]: 8n })]);
    expect(bad.invariantViolated?.unmatched_deltas).toEqual({ [W]: '1' });
  });

  it('reports the first failing leg with the Verifier error strings', () => {
    const m = model();
    const [a, b] = [agent(), agent()];
    m.deposit(a.id, W, 1000n);
    const ok = leg(a, { [W]: -1000n, [U]: 999n });
    expect(m.simulate([ok, leg(b, { [U]: -1000n, [W]: 999n })]).errorClass).toBe('insufficient balance or overflow');
    const tampered = structuredClone(ok);
    tampered.payload.message = tampered.payload.message.replace('999', '998');
    expect(m.simulate([tampered]).errorClass).toBe('invalid signature');
    expect(m.simulate([leg(a, { [W]: -1000n, [U]: 999n }, { salt: '00000000' })]).errorClass).toBe('invalid salt');
    // signTokenDiff refuses zero amounts, so build the zero-amount leg by hand
    const zero = signIntents({ signerId: a.id, secretKey: a.sk, verifierId: V, salt: SALT, deadline: later(), intents: [{ intent: 'token_diff', diff: { [W]: '-1000', [U]: '0' } }] });
    expect(m.simulate([zero]).errorClass).toBe('invalid intent');
    expect(m.simulate([leg(a, { [W]: -1n }, { deadline: new Date(Date.now() - 1000) })]).errorClass).toBe('deadline has expired');
    expect(m.simulate([leg(a, { [W]: -1n }, { verifier: 'intents.near' })]).errorClass).toBe('wrong verifying_contract');
    const dl = later();
    expect(m.simulate([leg(a, { [W]: -1n }, { deadline: dl, nonce: buildNonce(SALT, new Date(dl.getTime() - 1000)) })]).errorClass).toBe('deadline is greater than nonce');
  });

  it('is all-or-nothing and rejects replayed nonces', () => {
    const m = model();
    const [a, b] = [agent(), agent()];
    m.deposit(a.id, W, 2000n); m.deposit(b.id, U, 2000n);
    const legs = [leg(a, { [W]: -1000n, [U]: 999n }), leg(b, { [U]: -1000n, [W]: 999n })];
    expect(m.execute(legs).ok).toBe(true);
    const before = m.balanceOf(a.id, W);
    const again = m.execute(legs);
    expect(again.errorClass).toBe('nonce was already used');
    expect(m.balanceOf(a.id, W)).toBe(before);
  });

  it('needs a registered key for named accounts; implicit accounts need none (K4)', () => {
    const m = model();
    const k = randomKeyPair();
    const named = { id: 'k4.nomadswarm.testnet', sk: k.secretKeyStr };
    m.deposit(named.id, W, 10_000n);
    expect(m.simulate([leg(named, { [W]: -1n })]).errorClass).toBe('public key not registered');
    m.addPublicKey(named.id, k.publicKeyStr);
    expect(m.simulate([leg(named, { [W]: -1000n })]).errorClass).toBe('invariant violated');
  });

  it('models fee-free transfer intents', () => {
    const m = model();
    const [a, b] = [agent(), agent()];
    m.deposit(a.id, W, 10n);
    const t = signIntents({ signerId: a.id, secretKey: a.sk, verifierId: V, salt: SALT, deadline: later(), intents: [{ intent: 'transfer', receiver_id: b.id, tokens: { [W]: '10' } }] });
    expect(m.execute([t]).ok).toBe(true);
    expect(m.balanceOf(b.id, W)).toBe(10n);
  });
});
