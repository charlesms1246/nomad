# Nomad: agents trade in rings, settled in one NEAR Intents call (NEAR HACKATHON 2026)

> Not related to the Nomad cross-chain bridge that was hacked in 2022. This is a different project with a different codebase.

**Network: NEAR testnet only.** `intents.near` exists only on mainnet, so we built the upstream near/intents Verifier (defuse 0.4.5, commit `16d04f6`) and deployed it at `intents.nomadswarm.testnet`. All rings settle there. Mainnet is used only for read-only view calls and 1Click dry quotes, which serve as the price baseline. Every figure below links to [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md), which has the tx hashes.

## What it is

- AI agents post offers on a public board: "I give up to X of token A, and I want at least ρ of token B per unit."
- Matchers look for **loops** of 2 to 5 offers (A wants B's token, B wants C's, C wants A's) where the limit rates leave a surplus after the Verifier fee.
- Every agent checks and signs **only its own leg**, a NEP-413 `token_diff`. One `execute_intents` call on the Verifier settles the whole loop: every leg settles or none does. The matcher's fee is its own positive-only intent inside the same batch, so it can take only the surplus.

## Prerequisites

- Node ≥ 20.
- pnpm 9. The root `package.json` pins `pnpm@9.15.0` via `packageManager`, so `corepack enable` picks the right version.
- Rust only for `make test-rust`, `make test-sandbox` and building the contracts. `make test` runs the board's Rust unit tests, so it needs `cargo`.
- No NEAR keys or funds are needed for `make sim`, `make dry-run` or `make test`.

## Try it (no keys, no funds)

Output below was captured from this repo on 2026-11-14.

| Step | Command | You should see |
|---|---|---|
| 1 | `make sim` | `sim backend=ledger (7 ms) agents=20 tokens=5 seed=1 rounds=30: settled 11 rings (k=2:5 k=3:3 k=4:2 k=5:1), cleared 47% of offers by rings (18/38), 53% fell back to 1Click; agents' mean rate vs mid -18.3 bps vs 1Click baseline -49 bps => saved 30.7 bps; failed rings 0`. It is followed by a sweep over 3/5/8 tokens × 10–200 agents, and `out/clearing-rate.svg` and `out/ring-lengths.svg`. `SIM_BACKEND=model make sim` runs the same sim on the Verifier model with real ed25519 signatures |
| 2 | `make dry-run` | `ring-3.json: simulate_intents on intents.nomadswarm.testnet: 4 intents_executed (3 agents + matcher)`, then the same for ring-4 (5) and ring-5 (6). This is a read-only call to our testnet Verifier with committed signed fixtures |
| 3 | `node packages/colo/dist/cli.js where intents-matcher.nomadswarm.testnet` (after step 1, which builds) | `intents-matcher.nomadswarm.testnet → shard 7 ["game.hot.tg-0", "kkuuue2akv_1630967379.near") (testnet)`, read from the live shard layout |
| 4 | `make test` | Each TypeScript package reports `Tests N passed`: 108 passed, with 4 live-network tests skipped. Then the board's Rust tests report `test result: ok. 40 passed` |
| 5 | `cd web && npm install && npm run dev` | The UI at http://localhost:3000. With no `MATCHER_URL` set, it shows a fixture labelled **MOCK DATA**. `make sim-serve` plus `make ui` shows a running simulation instead |
| 6 | Testnet proof | The tx links under [Deployments](#deployments) |

`pnpm install && pnpm test` also works: the root `test` script builds the packages first.

## Feature → file → test

| Feature | File | Test or evidence |
|---|---|---|
| Ring search, fee-correct sizing, surplus split | [packages/ringfinder/src/index.ts](packages/ringfinder/src/index.ts) | [ringfinder.test.ts](packages/ringfinder/test/ringfinder.test.ts) (property tests) |
| An agent never signs outside its offer | [apps/agent/src/legCheck.ts](apps/agent/src/legCheck.ts) | [legCheck.test.ts](apps/agent/test/legCheck.test.ts); [legCheck.prop.test.ts](apps/agent/test/legCheck.prop.test.ts) (fast-check, through the real signing path; each of the 5 guards was removed in turn and the tests caught it) |
| Agent strategies | [apps/agent/src/strategies.ts](apps/agent/src/strategies.ts) | [strategies.test.ts](apps/agent/test/strategies.test.ts) |
| Matcher loop: propose → collect → simulate → execute | [apps/matcher/src/matcher.ts](apps/matcher/src/matcher.ts) | [matcher.test.ts](apps/matcher/test/matcher.test.ts) (end to end); live rings in [MEASUREMENTS](docs/MEASUREMENTS.md#live-rings-make-live) |
| NEP-413 signing, versioned nonce, Verifier client | [packages/intents/src](packages/intents/src) | [intents.test.ts](packages/intents/test/intents.test.ts) (golden vector, cross-checked against `node:crypto`); K1–K8 on testnet |
| Our Verifier deployment | [contracts/verifier/build.sh](contracts/verifier/build.sh), [deploy.ts](contracts/verifier/deploy.ts) | wasm sha256 `cb632a69…daedf`; [MEASUREMENTS § Deployment](docs/MEASUREMENTS.md#deployment) |
| Kill tests K1–K8 | [scripts/k1-ring3.ts](scripts/k1-ring3.ts) … [k8-deadline.ts](scripts/k8-deadline.ts) | [MEASUREMENTS § Kill tests](docs/MEASUREMENTS.md#kill-tests): 7 pass; K7 fails as specified (see [Shard placement](#shard-placement-a-measured-negative-result)) |
| Local Verifier model | [packages/verifier-model/src/index.ts](packages/verifier-model/src/index.ts) | [model.test.ts](packages/verifier-model/test/model.test.ts); [differential.live.ts](packages/verifier-model/test/differential.live.ts): 500/500 random batches agree with testnet `simulate_intents` on outcome, error, `unmatched_deltas` and intent hashes |
| Sim on the Verifier model | [apps/matcher/src/model-chain.ts](apps/matcher/src/model-chain.ts) | `SIM_BACKEND=model make sim` gives the same rings as the ledger backend |
| Attacks on chain (an agent spends first, the matcher inflates or alters a leg, replay, stale salt, zero amount) | [scripts/attacks.ts](scripts/attacks.ts) | [MEASUREMENTS § Attacks](docs/MEASUREMENTS.md#attack-and-failure-tests-on-chain-attacksts): all fail with the expected error and move no balance |
| Race safety: one nonce per offer | [apps/agent/src/runtime.ts](apps/agent/src/runtime.ts) (`398cbd4`, rotation `764f9d8`) | A7/A8 in [attacks.ts](scripts/attacks.ts); [race.test.ts](apps/matcher/test/race.test.ts), [race2.test.ts](apps/matcher/test/race2.test.ts) |
| Delegated relayer key and 3-way race | [apps/matcher/src/cli-relayer-key.ts](apps/matcher/src/cli-relayer-key.ts), `SUBMIT_AS=verifier` in [cli-live.ts](apps/matcher/src/cli-live.ts) | `make relayer-key && make race3`; [race3.json](docs/measurements/race3.json) |
| Shard tool `colo` (CLI, library, MCP server) | [packages/colo/src](packages/colo/src) | [packages/colo/test](packages/colo/test) |
| Agent MCP server `nomad-mcp`: 6 tools (`nomad_tokens`, `nomad_balance`, `nomad_offer`, `nomad_cancel`, `nomad_status`, `nomad_leaderboard`) | [apps/agent/src/mcp.ts](apps/agent/src/mcp.ts) | No automated test |
| Offer board (rules in [RULES.md](RULES.md)) | [contracts/board/src/lib.rs](contracts/board/src/lib.rs) | `make test-rust` (40 unit tests); `make test-sandbox` (near-workspaces, needs cargo-near) |
| 1Click baseline and guarded fallback | [packages/oneclick/src](packages/oneclick/src) | [packages/oneclick/test](packages/oneclick/test). The fallback refuses to run on testnet by design: `1Click fallback is mainnet-only; refusing on testnet` ([fallback.ts](packages/oneclick/src/fallback.ts)) |
| LLM mode (NEAR AI Cloud sets an agent's margin; `legCheck` still decides every signature) | [apps/agent/src/llm.ts](apps/agent/src/llm.ts) | [llm.test.ts](apps/agent/test/llm.test.ts) against a mocked API, including clamping to [0, 5%]. Not run against the live API: it needs `LLM=1 NEARAI_API_KEY=…`, and we had no key |
| Signed fixtures for `make dry-run` | [fixtures/rings](fixtures/rings), signed by `make fixtures` | Signed by dedicated agents `fx01`–`fx12` (`make fixture-accounts`), so live trading never drains them |
| House of Stake spend budgets (stretch) | [scripts/hos-budget.ts](scripts/hos-budget.ts), [contracts/hos/build.sh](contracts/hos/build.sh) | [docs/HOS_BUDGETS.md](docs/HOS_BUDGETS.md), [hos-budget.json](docs/measurements/hos-budget.json); limits in [docs/research/HOS_LIMITS.md](docs/research/HOS_LIMITS.md) |
| UI: ring graph, rings table, swarm and race panels | [web/components](web/components), API shape in [web/lib/types.ts](web/lib/types.ts) | `cd web && npm run build`; `make ui-check` (sim matcher + local dev UI + headless screenshot to `out/ui-check/ui.png`) |
| Matcher container (read-only public API) | [apps/matcher/Dockerfile](apps/matcher/Dockerfile), [apps/matcher/src/server.ts](apps/matcher/src/server.ts) | [docs/DEPLOY.md](docs/DEPLOY.md): with `PUBLIC=1`, only `GET /api/state` and `/healthz` are served |

## What is real vs simulated

| Part | Real | Simulated |
|---|---|---|
| Settlement | `execute_intents` on our testnet Verifier, real NEP-413 signatures, real testnet NEP-141 tokens | `make sim` uses an in-process ledger or the Verifier model, with no chain |
| Tokens | `wnear`, `usdc`, `usdt`, `btc`, `zec` `.nomadswarm.testnet` | They have no market value |
| Prices and the 1Click baseline | Live mainnet 1Click dry quotes (read-only, no funds) | The sim uses one fixed baseline quote (−49 bps on 2026-11-13) |
| Agents | `a01`–`a12.nomadswarm.testnet`, each with its own Verifier key | Sim agents are in-process |
| Fallback execution through 1Click | Refused on testnet by design (1Click is mainnet-only) | Quotes only |
| LLM mode | Coded and unit-tested against a mocked API | Not run against the live NEAR AI Cloud API |
| UI | Reads the matcher's `/api/state` | With no reachable matcher, a fixture labelled MOCK DATA |

## NEAR primitives used, and why

- **`execute_intents` on the Intents Verifier.** It takes many signers' intents in one call, checks that each token's deltas net to zero, and commits all or none. That is the whole atomic ring, with no escrow contract of our own. A 3-agent ring settled in one receipt using 11.36 Tgas (K1). Gas is about 3.25 + 2.53 Tgas per signer (K3).
- **`simulate_intents`.** A free view call. The matcher dry-runs every ring before submitting it, and anyone can replay our fixtures with no key (`make dry-run`).
- **NEP-413 signed `token_diff` intents.** Each agent signs one exact diff, −give and +get. Changing a leg breaks its signature (attack A3).
- **The Verifier fee rule.** Each negative delta pays `ceil(|d| · fee / 1e6)`, and the receiver gets `x − fee`. Ring sizing accounts for this (K5).
- **Versioned nonces and salts.** One nonce per offer means two matchers can't both settle the same offer (A7).
- **Function-call access keys.** Agents' board keys can only post and cancel offers. The relayer key on the Verifier account can only call `execute_intents`.
- **Sub-accounts.** One per agent, each registering its intents key with `add_public_key` (K4).

## Shard placement: a measured negative result

The original plan was to name the matcher onto the Verifier's shard so that its transactions execute a block sooner. **We measured that this saves nothing.**

- **K7** sent 20 txs per arm to our Verifier. A same-shard signer took 1 block in 20/20 cases, and so did an other-shard signer. The Verifier signing its own tx took 0 blocks in 20/20.
- **The reason.** A receipt executes in its transaction's block only when `signer_id == receiver_id` (a *local receipt*: nearcore `runtime/runtime/src/lib.rs` L3196-3214). The rule compares account ids, not shards. See [docs/research/SHARD_LATENCY.md](docs/research/SHARD_LATENCY.md).
- **How mainnet does it.** `intents.near` holds 9 function-call keys limited to `execute_intents`, so its relayer signs as the contract itself. Our earlier mainnet probe (27/27 txs in the inclusion block) was confounded: every one of those txs was signed by `intents.near`.
- **What we reproduce.** `make relayer-key` adds a function-call key on `intents.nomadswarm.testnet`, limited to `execute_intents` with no allowance. A matcher run with `SUBMIT_AS=verifier` submits through it. The key can only submit batches: every intent inside still needs its owner's signature.
- **3-way race** (`make race3`, [race3.json](docs/measurements/race3.json)). Three matchers got the same ring at the same moment, with one nonce per offer, so only one batch could execute.
  - The Verifier-signed matcher took **0 blocks in 26/26** and won **26 of 27** races.
  - The same-shard and other-shard matchers each took **1 block in 27/27**.
  - One race had no winner, because of an RPC transport error.
  - Every losing batch failed with `nonce was already used` and moved nothing.

`colo` still exists as a tool (`where`, `place`, `check`, `latency`). It reports shards correctly; it just doesn't make a matcher faster.

## Measurements

All of these are in [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md), with tx hashes and raw JSON in [docs/measurements/](docs/measurements/).

- **Kill tests K1–K8:** 7 pass. K7 fails as specified; it is the finding above.
- **Differential test:** 500/500 random batches agree between `packages/verifier-model` and testnet `simulate_intents` (seed 1 with N = 200, seed 7 with N = 300).
- **Attacks on chain:** all 10 rows pass. Each attack fails with the expected Verifier error and moves no balance.
- **Live rings:** k = 3, 4 and 5 settled in one `execute_intents` each, for example [`3BJdW7Vr…`](https://testnet.nearblocks.io/txns/3BJdW7Vrn45r1T1tZY26hFSAUKSTPMxammsXDMaTib6J) (k = 4).
- **Sim sweep** (5 tokens, 3 seeds): the share of offers cleared by rings was 49.7% at 10 agents, 48.1% at 20, 49.6% at 50, 48.4% at 100 and 43.9% at 200. **It stays flat at about 44–50% and does not rise with more agents.** The number of rings grows with the number of offers (6 → 154). The sim's offers are random, so this says nothing about how often rings occur in a real agent economy.

## House of Stake spend budgets (stretch)

An agent's name can be a House of Stake leased account running the unmodified `hos-wallet` (houseofstake/tla-contracts `d85860a`). Its owner grants a USDC budget to the agent runtime. Runs of 2026-11-14 on testnet:

- Depositing 0.6 USDC into the Verifier under the budget worked.
- A second 0.6 USDC failed with `spend exceeds the granted cap for this token`.
- A receiver outside the grant failed.

We deployed the wallet directly instead of through the registry/registrar, because publishing it as a global contract would burn about 43 NEAR. Details and limits are in [docs/HOS_BUDGETS.md](docs/HOS_BUDGETS.md) and [docs/research/HOS_LIMITS.md](docs/research/HOS_LIMITS.md).

## Deployments

All on NEAR testnet. Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

| What | Account | Evidence |
|---|---|---|
| Verifier (near/intents defuse 0.4.5, unmodified, our build) | `intents.nomadswarm.testnet` | Deploy + `new`: [`B2ZwQmRV…`](https://testnet.nearblocks.io/txns/B2ZwQmRVh2MmWcZzRkchHoCkXcUrPhqxPiaeL3ZehjAZ) |
| Verifier fee collector (1 pip) | `fees.nomadswarm.testnet` | A balance inside the Verifier only; no on-chain account is needed (K6) |
| Test tokens | `wnear`, `usdc`, `usdt`, `btc`, `zec` `.nomadswarm.testnet` | [config/testnet.json](config/testnet.json) |
| Offer board | `board.nomadswarm.testnet` | [scripts/deploy-board.mjs](scripts/deploy-board.mjs) |
| Matcher, signing as the Verifier (relayer key, `execute_intents` only) | `intents-matcher-1.nomadswarm.testnet` | 3-way race winner: [`B3nwWbx8…`](https://testnet.nearblocks.io/txns/B3nwWbx8dptDiVobQpfuaq1h9xVrDh6gXyp9iAVTyKPg) (0 blocks) |
| Matcher on the Verifier's shard (7) | `intents-matcher.nomadswarm.testnet` | [`DqhyqX6n…`](https://testnet.nearblocks.io/txns/DqhyqX6n2aG735hN51HSbSA13xraqP52JKGnZrs19GJ5) (lost the race, 1 block) |
| Matcher on another shard (4) | `matcher.nomadswarm.testnet` | [`3H8CPxrV…`](https://testnet.nearblocks.io/txns/3H8CPxrVrTWP2uu2yqgpVdTrj928rDqM5kFdg33PLWKi) (lost the race, 1 block) |
| Live agents | `a01` … `a12` `.nomadswarm.testnet` | |
| Fixture agents (sign `fixtures/rings`) | `fx01` … `fx12` `.nomadswarm.testnet` | `make dry-run` |
| K7 arms | `k7colo` (shard 7), `zk7ctl` (shard 5) `.nomadswarm.testnet` | [K7](docs/MEASUREMENTS.md#k7-which-txs-execute-in-the-inclusion-block-k7-colots) |
| HoS demo | `nomad-agent-01.tla`, `treasury`, `hosauth`, `hosrt` `.nomadswarm.testnet` | [docs/HOS_BUDGETS.md](docs/HOS_BUDGETS.md) |

Ring settlements:
- K1 3-agent ring: [`BgjzT1Va…`](https://testnet.nearblocks.io/txns/BgjzT1VayBzmvfuqx29pmBnj1tzS1M7hxkXJ3sigVRKE).
- Live rings: [`EUKjsAMQ…`](https://testnet.nearblocks.io/txns/EUKjsAMQzasdX6xXLpc8huZtvz3hhVhJPNxf5pxRDYf2), [`tb8LgK1e…`](https://testnet.nearblocks.io/txns/tb8LgK1evng8wzYB8FT2T1n2g8LL3FCfU37u5dWRxfz) (k = 5) and [`3BJdW7Vr…`](https://testnet.nearblocks.io/txns/3BJdW7Vrn45r1T1tZY26hFSAUKSTPMxammsXDMaTib6J) (k = 4).

Our parent account `nomadswarm.testnet` is super-admin of this Verifier deployment, a centralisation point that only exists in our testnet setup.

## Threat model and known limits

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). In short:
- the matcher can take only what is left after every agent's signed amount (A2);
- a ring with an unfunded or altered leg fails as a whole (A1, A3);
- a leaked agent key loses that agent's inventory.

Only assets held inside the Verifier can be in a ring.

## Prior art, and how we differ

Details are in [docs/PRIOR_ART.md](docs/PRIOR_ART.md).

- **CoW Protocol** (Ethereum). Solvers find coincidences of wants, including rings, and settle them through CoW's own settlement contract. Nomad uses the same economic idea, with no solver auction and no settlement contract of its own.
- **Terra matcher** ([repo](https://github.com/archtum66-dev/terra-matcher)). Pairwise `token_diff` fills for human limit orders. Nomad clears agent loops of k = 2 to 5.
- **NEAR CLEARLOOP** ([repo](https://github.com/Subash-2207/near-clearloop)) and **Deloop**. They net debts in one asset. Nomad swaps held assets across tokens.
- **Solvers already submit multi-signer batches** to `intents.near` (e.g. tx `86bq2zQ2hCXTJVmLj3LTzZNLD7NrzniNBvYpQvHunqF3`, 3 signers). Multi-party atomic batches are not new. Our claim is narrower: agents find and settle loops among themselves.

## Built during NEAR HACKATHON

- All code in this repo was written during the hackathon. AI-assisted coding (Claude Code) was used throughout.
- **Upstream code we build and deploy unmodified, which is not our work:**
  - the NEAR Intents Verifier from [near/intents](https://github.com/near/intents) (commit `16d04f6`), plus its `fungible-token.wasm` for the test tokens;
  - `hos-wallet` from [houseofstake/tla-contracts](https://github.com/houseofstake/tla-contracts) (commit `d85860a`).
- **Libraries:**
  - `@noble/curves` and `@noble/hashes` (ed25519, sha256);
  - `ws` (agent bus);
  - `@modelcontextprotocol/sdk` and `zod` (MCP servers);
  - `fast-check` and `vitest` (tests);
  - `near-sdk` and `near-workspaces` (board contract and its sandbox test);
  - Next.js and Tailwind CSS (`web/`).
- There is no sibling project.

## License

MIT, see [LICENSE](LICENSE).
