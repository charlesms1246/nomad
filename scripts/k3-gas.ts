// K3: gas of a settled k-ring (+ matcher leg) for k = 2..10. Pick L = the largest k under 100 Tgas.
import { client, explorer, fundAgents, implicitAgent, legFor, log, parent, ringDiffs, ringTokens, saveResult } from './k-lib.js';

const fee = await client.fee();
const X = 1_000_000n;
const SURPLUS = 100n;
const ks = (process.argv[2] ?? '2,3,4,5,6,7,8,10').split(',').map(Number);
const rows: any[] = [];
for (const k of ks) {
  const toks = ringTokens(k);
  const agents = Array.from({ length: k }, implicitAgent);
  const matcher = implicitAgent();
  await fundAgents(agents.map((a, i) => ({ to: a.id, tokens: { [toks[i]!]: X } })));
  const diffs = ringDiffs(k, X, fee, toks);
  diffs[k - 1]![toks[0]!]! -= SURPLUS;
  const signed = [...(await Promise.all(agents.map((a, i) => legFor(a, diffs[i]!)))), await legFor(matcher, { [toks[0]!]: SURPLUS })];
  const sim = await client.simulate(signed);
  const ex = await client.execute(signed, parent);
  const row = { k, signers: k + 1, ok: ex.ok, error: ex.error, simulateOk: sim.ok, gasBurnt: ex.gasBurnt, tgas: Number(BigInt(ex.gasBurnt) / 10n ** 9n) / 1000, tx: ex.txHash, explorer: explorer(ex.txHash) };
  log(JSON.stringify(row));
  rows.push(row);
}
const under100 = rows.filter((r) => r.ok && r.tgas < 100).map((r) => r.k);
const L = Math.max(...under100);
// linear fit tgas = a + b·signers
const n = rows.length, sx = rows.reduce((s, r) => s + r.signers, 0), sy = rows.reduce((s, r) => s + r.tgas, 0);
const sxx = rows.reduce((s, r) => s + r.signers ** 2, 0), sxy = rows.reduce((s, r) => s + r.signers * r.tgas, 0);
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
saveResult('k3-gas', { pass: rows.every((r) => r.ok), L, fit: { baseTgas: +a.toFixed(3), perSignerTgas: +b.toFixed(3) }, rows });
log(`K3 L=${L} fit: ${a.toFixed(2)} + ${b.toFixed(2)}·signers Tgas`);
