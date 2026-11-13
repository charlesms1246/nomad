// TECH_DOC §16.3 attack and failure tests, ON CHAIN against our testnet Verifier.
// Every attack batch is actually submitted with execute_intents (not just simulated), so each
// row has a tx hash, and we check that no balance moved when a batch fails.
//
//  A1 an agent spends its balance before settlement      -> whole batch fails, nothing moves
//  A2 the matcher inflates its own leg                     -> invariant violated
//  A3 the matcher alters a signed leg                      -> invalid signature
//  A4 a leg replayed in a second batch                     -> nonce was already used
//  A5 a stale (invalidated) salt / a zero salt             -> invalid salt
//  A6 a zero amount                                        -> invalid intent
//  A7 two matchers race for overlapping rings, the shared agent signs both legs with the SAME
//     per-offer nonce (apps/agent runtime, 398cbd4)        -> one settles, the other: nonce was already used
//  A8 same race, but distinct nonces and balance for only one -> one settles, the other: insufficient balance
//
// Usage: tsx scripts/attacks.ts
import { buildNonce, intentHash, signIntents, signTokenDiff, signerFor, TGAS, type MultiPayload } from '../packages/intents/src/index.js';
import { balances, client, CONFIG, explorer, fundAgents, implicitAgent, legFor, log, parent, PARENT, rpc, saveResult, T, type Agent } from './k-lib.js';

const W = T.wNEAR!.id, U = T.USDC!.id, X = T.USDT!.id;
const fee = await client.fee();
const net = (x: bigint) => x - (x * BigInt(fee) + 999_999n) / 1_000_000n;
const rows: any[] = [];

/** Snapshot balances, submit, snapshot again; record whether anything moved. */
async function submit(name: string, expect: string, signed: MultiPayload[], watch: Agent[], submitter = parent) {
  const ids = watch.map((a) => a.id);
  const before = await balances(ids, [W, U, X]);
  const sim = await client.simulate(signed);
  const ex = await client.execute(signed, submitter);
  const after = await balances(ids, [W, U, X]);
  const moved = JSON.stringify(before) !== JSON.stringify(after);
  const pass = expect === 'settles' ? ex.ok : !ex.ok && !moved && !!ex.error?.includes(expect);
  const row = { name, expect, pass, tx: ex.txHash, explorer: explorer(ex.txHash), ok: ex.ok, error: ex.error, simulate: { ok: sim.ok, errorClass: sim.errorClass }, balancesMoved: moved };
  log(JSON.stringify({ name, pass, ok: ex.ok, error: ex.error, moved, tx: ex.txHash }));
  rows.push(row);
  return row;
}

/** A funded 2-agent swap: A gives 1000 W for U, B gives 1000 U for W, matcher M takes `cut` W. */
async function swap(cut = 5n) {
  const A = implicitAgent(), B = implicitAgent(), M = implicitAgent();
  await fundAgents([{ to: A.id, tokens: { [W]: 1000n } }, { to: B.id, tokens: { [U]: 1000n } }]);
  const legA = await legFor(A, { [W]: -1000n, [U]: net(1000n) });
  const legB = await legFor(B, { [U]: -1000n, [W]: net(1000n) - cut });
  const legM = await legFor(M, { [W]: cut });
  return { A, B, M, legA, legB, legM };
}

// A1: agent A empties its balance (a signed transfer it executes itself) after signing its ring leg.
{
  const s = await swap();
  const sink = implicitAgent();
  const spend = signIntents({ signerId: s.A.id, secretKey: s.A.secretKey, verifierId: CONFIG.verifierId, salt: await client.currentSalt(), deadline: new Date(Date.now() + 120_000), intents: [{ intent: 'transfer', receiver_id: sink.id, tokens: { [W]: '1000' } }] });
  const sp = await client.execute([spend], parent);
  log('A1 agent spends first:', sp.txHash, sp.ok);
  const r = await submit('A1 agent spent its balance before settlement', 'insufficient balance or overflow', [s.legA, s.legB, s.legM], [s.A, s.B, s.M]);
  r.spendTx = sp.txHash;
}

// A2: matcher inflates its own leg by 1.
{
  const s = await swap();
  const greedy = await legFor(s.M, { [W]: 6n });
  await submit('A2 matcher inflates its own leg', 'invariant violated', [s.legA, s.legB, greedy], [s.A, s.B, s.M]);
}

// A3: matcher alters agent B's signed leg (asks B to give less), keeping B's signature.
{
  const s = await swap();
  const forged = structuredClone(s.legB);
  forged.payload.message = forged.payload.message.replace('"-1000"', '"-990"');
  await submit('A3 matcher alters a signed leg', 'invalid signature', [s.legA, forged, s.legM], [s.A, s.B, s.M]);
}

// A4: settle once, then replay the same legs in a second batch.
{
  const s = await swap();
  await fundAgents([{ to: s.A.id, tokens: { [W]: 1000n } }, { to: s.B.id, tokens: { [U]: 1000n } }]); // so balance isn't what stops the replay
  const first = await submit('A4a original batch settles', 'settles', [s.legA, s.legB, s.legM], [s.A, s.B, s.M]);
  const replay = await submit('A4b replay of the same legs', 'nonce was already used', [s.legA, s.legB, s.legM], [s.A, s.B, s.M]);
  replay.originalTx = first.tx;
}

// A5: an invalidated (stale) salt, and the zero salt.
{
  const k8 = JSON.parse((await import('node:fs')).readFileSync(new URL('../docs/measurements/k8-deadline.json', import.meta.url), 'utf8'));
  const stale = k8.salts.S1 as string; // invalidated in K8
  log('A5 stale salt', stale, 'valid?', await client.isValidSalt(stale));
  for (const [label, salt] of [['stale (invalidated) salt ' + stale, stale], ['zero salt', '00000000']] as const) {
    const s = await swap();
    const bad = await legFor(s.A, { [W]: -1000n, [U]: net(1000n) }, { salt });
    await submit(`A5 ${label}`, 'invalid salt', [bad, s.legB, s.legM], [s.A, s.B, s.M]);
  }
}

// A6: a zero amount in a leg (built by hand: our signer refuses zero).
{
  const s = await swap();
  const zero = signIntents({ signerId: s.A.id, secretKey: s.A.secretKey, verifierId: CONFIG.verifierId, salt: await client.currentSalt(), deadline: new Date(Date.now() + 120_000), intents: [{ intent: 'token_diff', diff: { [W]: '-1000', [U]: String(net(1000n)), [X]: '0' } }] });
  await submit('A6 zero amount', 'invalid intent', [zero, s.legB, s.legM], [s.A, s.B, s.M]);
}

// A7/A8: two matchers race for overlapping rings that share agent S's offer.
//   ring 1: S gives W for U with P (P gives U for W)
//   ring 2: S gives W for U via Q, R (Q gives U for X, R gives X for W): a 3-ring
// S holds 1000 W, enough for ONE ring. Both rings are submitted concurrently from two accounts.
async function race(sharedNonce: boolean) {
  const S = implicitAgent(), P = implicitAgent(), Q = implicitAgent(), R = implicitAgent();
  await fundAgents([
    { to: S.id, tokens: { [W]: 1000n } },
    { to: P.id, tokens: { [U]: 1000n } },
    { to: Q.id, tokens: { [U]: 1000n } },
    { to: R.id, tokens: { [X]: 1000n } },
  ]);
  const salt = await client.currentSalt();
  const offerExpiry = new Date(Date.now() + 3600_000);
  const deadline = new Date(Date.now() + 120_000);
  const offerNonce = buildNonce(salt, offerExpiry); // what the runtime keeps per offer
  const legS = (n?: Uint8Array) =>
    signTokenDiff({ signerId: S.id, secretKey: S.secretKey, verifierId: CONFIG.verifierId, salt, deadline, diff: { [W]: '-1000', [U]: String(net(1000n)) }, nonce: n });
  const ring1 = [sharedNonce ? legS(offerNonce) : legS(), await legFor(P, { [U]: -1000n, [W]: net(1000n) })];
  const ring2 = [sharedNonce ? legS(offerNonce) : legS(), await legFor(Q, { [U]: -1000n, [X]: net(1000n) }), await legFor(R, { [X]: -1000n, [W]: net(1000n) })];
  // both pass simulation on their own: each is a valid ring
  const sim1 = await client.simulate(ring1), sim2 = await client.simulate(ring2);
  const m1 = signerFor(`k7colo.${PARENT}`), m2 = signerFor(`zk7ctl.${PARENT}`);
  const before = await balances([S.id, P.id, Q.id, R.id], [W, U, X]);
  const [e1, e2] = await Promise.all([client.execute(ring1, m1), client.execute(ring2, m2)]);
  const after = await balances([S.id, P.id, Q.id, R.id], [W, U, X]);
  const winner = e1.ok ? 'ring1' : e2.ok ? 'ring2' : 'none';
  const loser = e1.ok ? e2 : e1;
  const expect = sharedNonce ? 'nonce was already used' : 'insufficient balance or overflow';
  // the loser moved nothing: Q and R (ring 2) or P (ring 1) keep their funds if their ring lost
  const loserUntouched = winner === 'ring1' ? after[Q.id]![U] === '1000' && after[R.id]![X] === '1000' : winner === 'ring2' ? after[P.id]![U] === '1000' : false;
  const pass = (e1.ok !== e2.ok) && !!loser.error?.includes(expect) && loserUntouched && after[S.id]![W] === '0';
  const row = {
    name: sharedNonce ? 'A7 two matchers race, same per-offer nonce' : 'A8 two matchers race, distinct nonces, balance for one',
    expect, pass, sharedNonce,
    sameNonceInBothRings: ring1[0]!.payload.nonce === ring2[0]!.payload.nonce,
    simulateAlone: { ring1: sim1.ok, ring2: sim2.ok },
    ring1: { submitter: m1.signerId, tx: e1.txHash, explorer: explorer(e1.txHash), ok: e1.ok, error: e1.error, block: e1.blockHeight },
    ring2: { submitter: m2.signerId, tx: e2.txHash, explorer: explorer(e2.txHash), ok: e2.ok, error: e2.error, block: e2.blockHeight },
    winner, loserUntouched, before, after,
  };
  log(JSON.stringify({ name: row.name, pass, winner, e1: [e1.ok, e1.error], e2: [e2.ok, e2.error] }));
  rows.push(row);
}
await race(true);
await race(false);

const pass = rows.every((r) => r.pass);
saveResult('attacks', { pass, rows });
log(pass ? 'ATTACKS PASS' : 'ATTACKS FAIL', rows.filter((r) => !r.pass).map((r) => r.name));
