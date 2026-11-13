// K2: simulate_intents on a funded k-ring WITH a matcher leg returns intents_executed of length k+1.
// Also: a matcher that inflates its own leg by 1 unit is rejected (not zero-sum). Read-only after funding.
import { client, fundAgents, implicitAgent, legFor, log, ringDiffs, ringTokens, saveResult } from './k-lib.js';

const fee = await client.fee();
const X = 1_000_000n;
const SURPLUS = 500n; // the matcher's cut, taken in the closing token
const results: any[] = [];
for (const k of [2, 3, 4, 5]) {
  const toks = ringTokens(k);
  const agents = Array.from({ length: k }, implicitAgent);
  const matcher = implicitAgent();
  await fundAgents(agents.map((a, i) => ({ to: a.id, tokens: { [toks[i]!]: X } })));
  const diffs = ringDiffs(k, X, fee, toks);
  // last agent receives the closing token (toks[0]); it gives up SURPLUS of it to the matcher
  diffs[k - 1]![toks[0]!]! -= SURPLUS;
  const legs = await Promise.all(agents.map((a, i) => legFor(a, diffs[i]!)));
  const good = await client.simulate([...legs, await legFor(matcher, { [toks[0]!]: SURPLUS })]);
  const inflated = await client.simulate([...legs, await legFor(matcher, { [toks[0]!]: SURPLUS + 1n })]);
  const r = {
    k,
    ok: good.ok,
    intentsExecuted: good.intentsExecuted?.length,
    pass: good.ok && good.intentsExecuted?.length === k + 1 && !inflated.ok,
    inflatedMatcher: { ok: inflated.ok, errorClass: inflated.errorClass, invariantViolated: inflated.invariantViolated },
    tokens: toks,
  };
  log(JSON.stringify(r));
  results.push(r);
}
const pass = results.every((r) => r.pass);
saveResult('k2-dryrun', { pass, X, SURPLUS, results });
log(pass ? 'K2 PASS' : 'K2 FAIL');
