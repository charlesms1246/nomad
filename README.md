# Nomad: agents trade in rings, settled in one NEAR Intents call (NEAR HACKATHON 2026)

> Not related to the Nomad cross-chain bridge that was hacked in 2022. This is a different project with a different codebase.

Tracks: **AI Swarms** and **DeFi**.

**Network: NEAR testnet only.** `intents.near` exists only on mainnet. Our testnet Verifier `intents.nomadswarm.testnet` runs **mainnet `intents.near`'s exact wasm**: the code hash is `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` on both. Mainnet is used only for read-only view calls (`simulate_intents`, 1Click dry quotes). Every figure below links to [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md), which has the tx hashes.

Anyone can check the code hash with two RPC calls:

```sh
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.near"}}' | grep -o '"code_hash":"[^"]*"'
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.nomadswarm.testnet"}}' | grep -o '"code_hash":"[^"]*"'
```

Both print `"code_hash":"BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk"` (checked 2026-11-14).

## What it is

- AI agents post offers on a public board: "I give up to X of token A, and I want at least ρ of token B per unit."
- Matchers look for **loops** of 2 to 5 offers (A wants B's token, B wants C's, C wants A's) where the limit rates leave a surplus after the Verifier fee.
- Every agent checks and signs **only its own leg**, a NEP-413 `token_diff`. One `execute_intents` call on the Verifier settles the whole loop: every leg settles or none does.
- The matcher's fee is its own positive-only intent inside the same batch, so it can take only the surplus. **Matchers compete for each agent's signature, and the agent signs the proposal that pays it best** (a per-offer auction, `make fee-race`).
- A matcher is a solver by another name, and it takes a cut. See [What the matcher takes](#what-the-matcher-takes-and-what-agents-save).

## Closest work, and what is actually different

**Kula** ([github.com/Sreeel9k/kula](https://github.com/Sreeel9k/kula), AI Swarms track, rings settled on testnet on 2026-11-09) is a direct twin, and it came first.
- Its agents post offers to a board, and scouts find closed circles of up to five members. Each member signs only its own NEP-413 `token_diff` leg, and one `execute_intents` settles the circle.
- Scouts **compete on their tip**: each member signs the proposal that pays it best (its RULES.md, rules 5–7).
- Each agent's **floor is a real 1Click dry quote**, and an agent that finds no ring takes that quote.
- It has a **read-only mainnet proof**: a signed ring reaches the balance check of the real `intents.near` through `simulate_intents`.
- It ran a **demand backtest** on 24 h of real mainnet `token_diff` swaps (150 swaps, $223,775). The share of volume that would find a ring was **0.0% within 5 minutes, 0.2% within 1 hour and 11.7% within a day**. Its conclusion is that rings suit money that can wait.

Everything in that list, Nomad also does or now does. Fee competition between matchers (`make fee-race`) and our mainnet proof (`make mainnet-proof`) were added after Kula's, and they catch up with it rather than go beyond it.

Other prior work:
- **CoW Protocol** ([coincidence of wants](https://docs.cow.fi/overview/coincidence-of-wants)). Ring trades are an established idea. Solvers there settle them through CoW's own contract.
- **Multi-signer cyclic batches already settle on mainnet `intents.near`.** In tx [`EEdfCacw…`](https://nearblocks.io/txns/EEdfCacwDJvoNmbFPbHep1KJ4pC2EtZoPFGTHxmZoiWs), signed by `intents.near`, three NEP-413 `token_diff` payloads (`solver-multichain-asset.near`, `solver-priv-liq.near` and a user's implicit account) form a USDT(BSC) → USDT(ETH) → PEPE → USDT(BSC) loop in one `execute_intents`. We read this on chain on 2026-11-14.
- **Terra matcher** ([repo](https://github.com/archtum66-dev/terra-matcher)). Pairwise `token_diff` fills for human limit orders.

What we claim as different, and nothing more:
1. **One-of-N commitments through a shared nonce.**
   - An agent signs every competing proposal for one offer, including different rings from different matchers, with **the same Verifier nonce**. At most one of them can ever execute, whatever the agent's balance.
   - Evidence: in the 3-way race, all 54 losing batches ([race3.json](docs/measurements/race3.json)) failed with `nonce was already used`. A failed `execute_intents` changes no balance, and attack A7 checks the balances explicitly ([attacks.ts](scripts/attacks.ts)).
   - What we checked first:
     - Kula's README and RULES.md use the nonce only for replay ("the Verifier's nonce stops the second one"). They avoid double fills by having each member sign only the single best proposal.
     - The NEAR Intents docs say the nonce "must be unique per intent to prevent replay attacks" and should "never [be] reused for the same account". They don't describe sharing one nonce across alternative payloads.
     - So this pattern deliberately departs from the docs' advice. It relies on the contract's single-use nonce check, which we measured (K8, A4b, A7, race3).
   - We don't know whether someone has done it before.
2. **Standing agent inventories with a 1Click fallback.**
   - Agents keep their balances inside the Verifier between rings, instead of bringing one swap at a time.
   - An offer that finds no ring falls back to 1Click. On testnet that fallback is modelled only: the sim counts it, and live execution is refused because 1Click is mainnet-only.
3. **A measured latency finding, offered as research.** On NEAR, only a transaction whose signer *is* the Verifier executes in its inclusion block. Shard placement doesn't help. See the [research appendix](#research-appendix).

## Prerequisites

- Node ≥ 20.
- pnpm 9. The root `package.json` pins `pnpm@9.15.0` via `packageManager`, so `corepack enable` picks the right version.
- Rust only for `make test-rust`, `make test-sandbox` and building the contracts. `make test` runs the board's Rust unit tests, so it needs `cargo`.
- No NEAR keys or funds are needed for `make sim`, `make dry-run`, `make mainnet-proof` or `make test`.

## Try it (no keys, no funds)

Output below was captured from this repo on 2026-11-14.

| Step | Command | You should see |
|---|---|---|
| 1 | `make sim` | `sim backend=ledger (7 ms) agents=20 tokens=5 seed=1 rounds=30: settled 11 rings (k=2:5 k=3:3 k=4:2 k=5:1), cleared 47% of offers by rings (18/38), 53% fell back to 1Click; agents' mean rate vs mid -18.3 bps vs 1Click baseline -49 bps => saved 30.7 bps; failed rings 0`. A sweep over 3/5/8 tokens × 10–200 agents follows, plus `out/clearing-rate.svg` and `out/ring-lengths.svg`. `SIM_BACKEND=model make sim` runs the same sim on the Verifier model with real ed25519 signatures. The "saved" figure is against a 1Click quote that includes its 20 bps keyless app fee |
| 2 | `make dry-run` | `ring-3.json: simulate_intents on intents.nomadswarm.testnet: 4 intents_executed (3 agents + matcher)`, then the same for ring-4 (5) and ring-5 (6). This is a read-only call to our testnet Verifier with committed signed fixtures |
| 3 | `make mainnet-proof` | `ring (3 agents), leg 1 first: insufficient balance or overflow` (and the same for legs 2 and 3), then `control: corrupted signature: invalid signature` and `control: zero salt: invalid salt`. This is read-only `simulate_intents` on **mainnet `intents.near`** |
| 4 | `make test` | Each TypeScript package reports `Tests N passed`. Then the board's Rust tests report `test result: ok` |
| 5 | `cd web && npm install && npm run dev` | The UI at http://localhost:3000. With no reachable `MATCHER_URL`, it shows a recorded real testnet state (a 3-way race capture, with real tx links) labelled **Recorded testnet data · 2026-11-13 23:53 UTC**. `make sim-serve` plus `make ui` shows a running simulation, labelled **Simulation**. `MATCHER_URL=http://localhost:1 make ui-check` prints `ui-check: source=recorded agents=12 rings=18 settled=6` |
| 6 | Testnet proof | The tx links under [Deployments](#deployments) |

What `make mainnet-proof` shows, and no more:
- It signs a 3-agent ring for mainnet `intents.near` with our signer. It runs the ring three times, rotated so that each leg is checked first once, because the Verifier checks payloads in order.
- Each run passes the signature, nonce and salt checks and stops only at the balance check. The accounts are unfunded implicit accounts.
- **No funded mainnet ring was settled.**
- Data: [mainnet-simulate.json](docs/measurements/mainnet-simulate.json).

`pnpm install && pnpm test` also works: the root `test` script builds the packages first.

## Feature → file → test

| Feature | File | Test or evidence |
|---|---|---|
| Ring search, fee-correct sizing, surplus split | [packages/ringfinder/src/index.ts](packages/ringfinder/src/index.ts) | [ringfinder.test.ts](packages/ringfinder/test/ringfinder.test.ts) (property tests) |
| An agent never signs outside its offer | [apps/agent/src/legCheck.ts](apps/agent/src/legCheck.ts) | [legCheck.test.ts](apps/agent/test/legCheck.test.ts); [legCheck.prop.test.ts](apps/agent/test/legCheck.prop.test.ts) (fast-check, through the real signing path; each of the 5 guards was removed in turn and the tests caught it) |
| Agent strategies | [apps/agent/src/strategies.ts](apps/agent/src/strategies.ts) | [strategies.test.ts](apps/agent/test/strategies.test.ts) |
| Matcher loop: propose → collect → simulate → execute | [apps/matcher/src/matcher.ts](apps/matcher/src/matcher.ts) | [matcher.test.ts](apps/matcher/test/matcher.test.ts) (end to end); live rings in [MEASUREMENTS](docs/MEASUREMENTS.md#36-minute-live-run-submit_asverifier-auto_fund10-make-live) |
| NEP-413 signing, versioned nonce, Verifier client | [packages/intents/src](packages/intents/src) | [intents.test.ts](packages/intents/test/intents.test.ts) (golden vector, cross-checked against `node:crypto`); K1–K8 on testnet |
| Our testnet Verifier runs mainnet's exact bytes | [scripts/verifier-mainnet-bytes.ts](scripts/verifier-mainnet-bytes.ts) (reads the code from mainnet with `view_code`, checks the hash, deploys). [contracts/verifier/build.sh](contracts/verifier/build.sh) and [deploy.ts](contracts/verifier/deploy.ts) are how we first built and deployed it, from near/intents `16d04f6` | Code hash `BtA1BEFN…` on both networks; [MEASUREMENTS § Verifier verifiability](docs/MEASUREMENTS.md#verifier-verifiability-2026-11-14) |
| Read-only mainnet proof | [scripts/mainnet-simulate.ts](scripts/mainnet-simulate.ts) | `make mainnet-proof`; [mainnet-simulate.json](docs/measurements/mainnet-simulate.json) |
| Kill tests K1–K8 | [scripts/k1-ring3.ts](scripts/k1-ring3.ts) … [k8-deadline.ts](scripts/k8-deadline.ts) | [MEASUREMENTS § Kill tests](docs/MEASUREMENTS.md#kill-tests): 7 pass; K7 fails as specified (see the [research appendix](#research-appendix)) |
| Local Verifier model | [packages/verifier-model/src/index.ts](packages/verifier-model/src/index.ts) | [model.test.ts](packages/verifier-model/test/model.test.ts); [differential.live.ts](packages/verifier-model/test/differential.live.ts): 500/500 random batches agree with testnet `simulate_intents` on outcome, error, `unmatched_deltas` and intent hashes |
| Sim on the Verifier model | [apps/matcher/src/model-chain.ts](apps/matcher/src/model-chain.ts) | `SIM_BACKEND=model make sim` gives the same rings as the ledger backend |
| Attacks on chain (an agent spends first, the matcher inflates or alters a leg, replay, stale salt, zero amount) | [scripts/attacks.ts](scripts/attacks.ts) | [MEASUREMENTS § Attacks](docs/MEASUREMENTS.md#attack-and-failure-tests-on-chain-attacksts): all fail with the expected error and move no balance |
| One-of-N commitments: one nonce per offer | [apps/agent/src/runtime.ts](apps/agent/src/runtime.ts) (`398cbd4`, rotation `764f9d8`) | A7/A8 in [attacks.ts](scripts/attacks.ts); [race.test.ts](apps/matcher/test/race.test.ts), [race2.test.ts](apps/matcher/test/race2.test.ts) |
| Matchers compete on fee: per-matcher φ, per-offer auction in each agent | `AgentRuntime.onProposalAsync` in [apps/agent/src/runtime.ts](apps/agent/src/runtime.ts) | [fee-competition.test.ts](apps/matcher/test/fee-competition.test.ts); `make fee-race`, [fee-race.json](docs/measurements/fee-race.json) |
| (Research appendix) Delegated relayer key and 3-way race | [apps/matcher/src/cli-relayer-key.ts](apps/matcher/src/cli-relayer-key.ts), `SUBMIT_AS=verifier` in [cli-live.ts](apps/matcher/src/cli-live.ts) | `make relayer-key && make race3`; [race3.json](docs/measurements/race3.json) |
| (Research appendix) Shard tool `colo` (CLI, library, MCP server) | [packages/colo/src](packages/colo/src) | [packages/colo/test](packages/colo/test) |
| Agent MCP server `nomad-mcp`: 6 tools (`nomad_tokens`, `nomad_balance`, `nomad_offer`, `nomad_cancel`, `nomad_status`, `nomad_leaderboard`) | [apps/agent/src/mcp.ts](apps/agent/src/mcp.ts) | No automated test |
| Offer board (rules in [RULES.md](RULES.md)) | [contracts/board/src/lib.rs](contracts/board/src/lib.rs) | `make test-rust` (40 unit tests); `make test-sandbox` (near-workspaces, needs cargo-near) |
| 1Click baseline and guarded fallback | [packages/oneclick/src](packages/oneclick/src) | [packages/oneclick/test](packages/oneclick/test). The fallback refuses to run on testnet by design: `1Click fallback is mainnet-only; refusing on testnet` ([fallback.ts](packages/oneclick/src/fallback.ts)) |
| LLM mode (NEAR AI Cloud sets an agent's margin; `legCheck` still decides every signature) | [apps/agent/src/llm.ts](apps/agent/src/llm.ts) | [llm.test.ts](apps/agent/test/llm.test.ts) against a mocked API, including clamping to [0, 5%]. Not run against the live API: it needs `LLM=1 NEARAI_API_KEY=…`, and we had no key |
| Signed fixtures for `make dry-run` | [fixtures/rings](fixtures/rings), signed by `make fixtures` | Signed by dedicated agents `fx01`–`fx12` (`make fixture-accounts`), so live trading never drains them |
| (Research appendix) House of Stake spend budgets | [scripts/hos-budget.ts](scripts/hos-budget.ts), [contracts/hos/build.sh](contracts/hos/build.sh) | [docs/HOS_BUDGETS.md](docs/HOS_BUDGETS.md), [hos-budget.json](docs/measurements/hos-budget.json); limits in [docs/research/HOS_LIMITS.md](docs/research/HOS_LIMITS.md) |
| UI: ring graph, rings table, swarm and race panels | [web/components](web/components), API shape in [web/lib/types.ts](web/lib/types.ts) | `cd web && npx next build`; `make ui-check` (sim matcher + local dev UI + headless screenshot to `out/ui-check/ui.png`) |
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
| UI | Reads the matcher's `/api/state` (badge LIVE). With no reachable matcher, a recorded real testnet state from 2026-11-13 23:53 UTC ([web/lib/live-snapshot.json](web/lib/live-snapshot.json)), labelled as recorded | With `make sim-serve`, simulated state labelled Simulation. `?mock=1` serves an invented layout fixture for UI development only |

## NEAR primitives used, and why

- **`execute_intents` on the Intents Verifier.** It takes many signers' intents in one call, checks that each token's deltas net to zero, and commits all or none. That is the whole atomic ring, with no escrow contract of our own. A 3-agent ring settled in one receipt using 11.36 Tgas (K1). Gas is about 3.25 + 2.53 Tgas per signer (K3).
- **`simulate_intents`.** A free view call. The matcher dry-runs every ring before submitting it, and anyone can replay our fixtures with no key (`make dry-run`).
- **NEP-413 signed `token_diff` intents.** Each agent signs one exact diff, −give and +get. Changing a leg breaks its signature (attack A3).
- **The Verifier fee rule.** Each negative delta pays `ceil(|d| · fee / 1e6)`, and the receiver gets `x − fee`. Ring sizing accounts for this (K5).
- **Versioned nonces and salts.** One nonce per offer means two matchers can't both settle the same offer (A7).
- **Function-call access keys.** Agents' board keys can only post and cancel offers. The relayer key on the Verifier account can only call `execute_intents`.
- **Sub-accounts.** One per agent, each registering its intents key with `add_public_key` (K4).

## What the matcher takes, and what agents save

- **The matcher's take.** In live mode each matcher keeps a share φ of the ring's surplus. The default is φ = 0.2 unless `RACE_PHI` is set.
  - In the 36-minute live run (φ = 0.2, one matcher), the median take was **61 bps of the closing leg**, the leg the matcher is paid from. That is about **15 bps of total ring value** if you spread it over the k legs (`matcherShareBps` in [live-30min.json](docs/measurements/live-30min.json), defined in [types.ts](apps/matcher/src/types.ts)).
  - That was a single matcher setting its own price, effectively a monopoly solver.
- **With fee competition** (`make fee-race`, [fee-race.json](docs/measurements/fee-race.json)): three equal-speed matchers at φ 0.35, 0.20 and 0.05 proposed on the same rings, with the 35% one proposing first.
  - The mean takes were 104, 59 and **14.8** bps of the closing leg, roughly a quarter of that in bps of ring value. The 5% matcher won all 7 settled rounds.
  - 7 of 14 rounds had no winner. Each was the second ring of a round, sized from offers the first ring had already consumed. This costs liveness, not safety.
  - These are **3 matchers we run, not an open market**. Kula's scouts already compete on fees, so this catches up with Kula and does not go beyond it.
- **What agents save.** The 36-minute live run measured a mean of **+20.5 bps** against a same-time 1Click mainnet dry quote per leg (21 rings).
  - **Most of that is 1Click's 20 bps app fee**, which applies to keyless quotes. With that fee removed, the saving is about **+0.5 bps**. This is arithmetic on the recorded figures, not a separate measurement.
  - The rings were tiny test amounts between our own agents.

## Measurements

All of these are in [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md), with tx hashes and raw JSON in [docs/measurements/](docs/measurements/).

- **Kill tests K1–K8:** 7 pass. K7 fails as specified; see the [research appendix](#research-appendix).
- **Differential test:** 500/500 random batches agree between `packages/verifier-model` and testnet `simulate_intents` (seed 1 with N = 200, seed 7 with N = 300).
- **Attacks on chain:** all 10 rows pass. Each attack fails with the expected Verifier error and moves no balance.
- **One-of-N commitments:** in the 3-way race, all 54 losing batches failed with `nonce was already used` ([race3.json](docs/measurements/race3.json)).
- **Read-only mainnet proof:** `make mainnet-proof`, described [above](#try-it-no-keys-no-funds).
- **36-minute live run** (2026-11-14, 00:35–01:11 UTC, 12 agents, one matcher at φ = 0.2, `SUBMIT_AS=verifier AUTO_FUND=10 make live`; [live-30min.json](docs/measurements/live-30min.json)):
  - **27 rings settled, 0 failed** (k = 3: 4, k = 4: 17, k = 5: 6), each in one `execute_intents` call;
  - about 15.1 Tgas per ring;
  - savings and the matcher's take as [above](#what-the-matcher-takes-and-what-agents-save);
  - examples: [`Fd5Q86nQ…`](https://testnet.nearblocks.io/txns/Fd5Q86nQS8qmn4aQz7of5vXXUx86sscwNpFa5J1sPoCw) (k = 4), [`EqLHddfT…`](https://testnet.nearblocks.io/txns/EqLHddfTmLVHUVgE5MUZcfgT56SfLCWSr4nBFdWSPso3) (k = 5).
  - The batches were submitted through the operator's delegated key on the Verifier, so they executed in the inclusion block. A third-party matcher can't do that; it takes 1 block (research appendix).
  - These are tiny test-sized rings between our own 12 agents, with no market value; the savings total $0.087. They show the mechanism works end to end, not demand or liquidity.
- **Sim sweep** (5 tokens, 3 seeds): the share of offers cleared by rings was 49.7% at 10 agents, 48.1% at 20, 49.6% at 50, 48.4% at 100 and 43.9% at 200. It does not rise with more agents. The sim's offers are random, so this says nothing about real demand.
- **Demand:** we have not measured real flow. Kula's mainnet backtest (0.0% of volume forms a ring within 5 min, 0.2% within 1 h, 11.7% within a day) is the best evidence we know of, and it suggests rings suit money that can wait.

## Deployments

All on NEAR testnet. Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

| What | Account | Evidence |
|---|---|---|
| Verifier (mainnet `intents.near`'s exact wasm, code hash `BtA1BEFN…`) | `intents.nomadswarm.testnet` | Mainnet bytes deployed: [`61ydnqMM…`](https://testnet.nearblocks.io/txns/61ydnqMMonrzThZhgVVoNdRkPsm2o8HMroLjTAMjdtFi). FullAccess key deleted: [`4EfJrpuF…`](https://testnet.nearblocks.io/txns/4EfJrpuFRMZKUi2Kv32mMyq29XieGr9uoRc7qtiuCkvq). Original deploy + `new` of our own build: [`B2ZwQmRV…`](https://testnet.nearblocks.io/txns/B2ZwQmRVh2MmWcZzRkchHoCkXcUrPhqxPiaeL3ZehjAZ). A live ring after the swap: [`2GNqc4Jv…`](https://testnet.nearblocks.io/txns/2GNqc4JvWGU6H4jMU8wnRwNWM2kbetHf4i78X8wKu4pH) |
| Verifier fee collector (1 pip) | `fees.nomadswarm.testnet` | A balance inside the Verifier only; no on-chain account is needed (K6) |
| Test tokens | `wnear`, `usdc`, `usdt`, `btc`, `zec` `.nomadswarm.testnet` | [config/testnet.json](config/testnet.json) |
| Offer board | `board.nomadswarm.testnet` | Create + deploy + `new`: [`qrQaozvX…`](https://testnet.nearblocks.io/txns/qrQaozvXXHwSMUkLfmWwzNQhaoNUZjW4pWpfD5mVxDX) ([scripts/deploy-board.mjs](scripts/deploy-board.mjs)); `add_matcher`: [`9xFg3fgs…`](https://testnet.nearblocks.io/txns/9xFg3fgsTMbxUKfGixus5fKoHx7wLBMgTiXsA3FuhyiN), [`7EvwrQXX…`](https://testnet.nearblocks.io/txns/7EvwrQXXXS78PW8cQ5N4xB5wzF4r6hffHUGXi93YLCqV) |
| Matcher, signing as the Verifier (relayer key, `execute_intents` only) | `intents-matcher-1.nomadswarm.testnet` | Relayer key `AddKey`: [`EytNTDhc…`](https://testnet.nearblocks.io/txns/EytNTDhc8KSSJ6XeT8CE2maSdNxwG3vkF1kfRuBRtUsg). 3-way race winner: [`B3nwWbx8…`](https://testnet.nearblocks.io/txns/B3nwWbx8dptDiVobQpfuaq1h9xVrDh6gXyp9iAVTyKPg) (0 blocks) |
| Matcher on the Verifier's shard (7) | `intents-matcher.nomadswarm.testnet` | Created [`3DNE9SS8…`](https://testnet.nearblocks.io/txns/3DNE9SS8LoDCkpK8sZZX7eRspBsS88y6VMySv73h5yde); [`DqhyqX6n…`](https://testnet.nearblocks.io/txns/DqhyqX6n2aG735hN51HSbSA13xraqP52JKGnZrs19GJ5) (lost the race, 1 block) |
| Matcher on another shard (4) | `matcher.nomadswarm.testnet` | Created [`5jFWwnWS…`](https://testnet.nearblocks.io/txns/5jFWwnWSYSNLJffkY1kYZjUj5HTpePmo1FJRfCpspUyM); [`3H8CPxrV…`](https://testnet.nearblocks.io/txns/3H8CPxrVrTWP2uu2yqgpVdTrj928rDqM5kFdg33PLWKi) (lost the race, 1 block) |
| Live agents | `a01` … `a12` `.nomadswarm.testnet` | `a01` created [`DE8HzxKp…`](https://testnet.nearblocks.io/txns/DE8HzxKpCm13mLMPDUG55GxtK27NH5DG8V1mS4JZEmDc) |
| Fixture agents (sign `fixtures/rings`) | `fx01` … `fx12` `.nomadswarm.testnet` | `make dry-run` |
| K7 arms | `k7colo` (shard 7), `zk7ctl` (shard 5) `.nomadswarm.testnet` | [K7](docs/MEASUREMENTS.md#k7-which-txs-execute-in-the-inclusion-block-k7-colots) |
| HoS demo | `nomad-agent-01.tla`, `treasury`, `hosauth`, `hosrt` `.nomadswarm.testnet` | [docs/HOS_BUDGETS.md](docs/HOS_BUDGETS.md) |

Ring settlements:
- K1 3-agent ring: [`BgjzT1Va…`](https://testnet.nearblocks.io/txns/BgjzT1VayBzmvfuqx29pmBnj1tzS1M7hxkXJ3sigVRKE).
- 36-minute live run: [`Fd5Q86nQ…`](https://testnet.nearblocks.io/txns/Fd5Q86nQS8qmn4aQz7of5vXXUx86sscwNpFa5J1sPoCw) (k = 4), [`EqLHddfT…`](https://testnet.nearblocks.io/txns/EqLHddfTmLVHUVgE5MUZcfgT56SfLCWSr4nBFdWSPso3) (k = 5); all 27 in [live-30min.json](docs/measurements/live-30min.json).
- First live rings: [`EUKjsAMQ…`](https://testnet.nearblocks.io/txns/EUKjsAMQzasdX6xXLpc8huZtvz3hhVhJPNxf5pxRDYf2), [`tb8LgK1e…`](https://testnet.nearblocks.io/txns/tb8LgK1evng8wzYB8FT2T1n2g8LL3FCfU37u5dWRxfz) (k = 5) and [`3BJdW7Vr…`](https://testnet.nearblocks.io/txns/3BJdW7Vrn45r1T1tZY26hFSAUKSTPMxammsXDMaTib6J) (k = 4).

**Who controls the Verifier.**
- The account has no FullAccess key. It keeps only one function-call key, limited to `execute_intents`.
- The contract's own access control still names `nomadswarm.testnet` as super-admin, with the roles `Upgrader`, `RelayerKeysManager` and `SaltManager`. So the team can still upgrade the code, manage relayer keys and rotate salts through the contract.
- This is the same model as mainnet, where the `intents.near` DAO holds those roles; here the holder is our team.

## Threat model and known limits

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). In short:
- the matcher can take only what is left after every agent's signed amount (A2);
- a ring with an unfunded or altered leg fails as a whole (A1, A3);
- a leaked agent key loses that agent's inventory;
- the team controls the testnet Verifier through its admin roles (see Deployments).

Only assets held inside the Verifier can be in a ring.

## Research appendix

These parts are research results or side experiments. They are not part of the pitch.

### Which transactions execute in their inclusion block

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

Executing in the inclusion block is **the operator's privilege**: only whoever holds a key on the Verifier account can get it. On mainnet that is the `intents.near` relayer. A third-party matcher always waits 1 block.

`colo` still exists as a tool. `make colo-check` prints `OK: intents-matcher.nomadswarm.testnet shard 7, intents.nomadswarm.testnet shard 7`. It reports shards correctly; it doesn't make a matcher faster.


### House of Stake spend budgets

An agent's name can be a House of Stake leased account running the unmodified `hos-wallet` (houseofstake/tla-contracts `d85860a`). Its owner grants a USDC budget to the agent runtime. Runs of 2026-11-14 on testnet:

- Depositing 0.6 USDC into the Verifier under the budget worked.
- A second 0.6 USDC failed with `spend exceeds the granted cap for this token`.
- A receiver outside the grant failed.

We deployed the wallet directly instead of through the registry/registrar, because publishing it as a global contract would burn about 43 NEAR. Details and limits are in [docs/HOS_BUDGETS.md](docs/HOS_BUDGETS.md) and [docs/research/HOS_LIMITS.md](docs/research/HOS_LIMITS.md).


## More prior art

Details are in [docs/PRIOR_ART.md](docs/PRIOR_ART.md).
- **NEAR CLEARLOOP** ([repo](https://github.com/Subash-2207/near-clearloop)) and **Deloop** net debts in one asset. Nomad swaps held assets across tokens.
- **Solvers already submit multi-signer batches** to `intents.near` (e.g. tx `86bq2zQ2hCXTJVmLj3LTzZNLD7NrzniNBvYpQvHunqF3`, 3 signers).

## Built during NEAR HACKATHON

- All code in this repo was written during the hackathon. AI-assisted coding (Claude Code) was used throughout.
- **Upstream code we deploy unmodified, which is not our work:**
  - the NEAR Intents Verifier from [near/intents](https://github.com/near/intents). Our testnet copy now runs mainnet `intents.near`'s exact wasm. We first built it ourselves from commit `16d04f6` with [contracts/verifier/build.sh](contracts/verifier/build.sh), which is kept in the repo. The test tokens use near/intents' `fungible-token.wasm`;
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
