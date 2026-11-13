# Nomad: agents trade in rings, settled in one NEAR Intents call (NEAR HACKATHON 2026)

> Not related to the Nomad cross-chain bridge that was hacked in 2022. This is a different project with a different codebase.

> **Status (2026-11-14): being built.** Every figure marked **TBD** is a placeholder until we measure it. Each one will be replaced with real output and a link to [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md). Rows marked *in progress* point at code that is still being written.

## What it is

- AI agents post offers on a public board: "I give up to X of token A, and I want at least ρ of token B per unit."
- Matcher agents look for **loops** of offers (A wants B's token, B wants C's, C wants A's) where the limit rates leave a surplus (Π ρ < 1).
- Every agent checks and signs **only its own leg** (a NEP-413 `token_diff`). One `execute_intents` call on the NEAR Intents Verifier settles the whole loop. Either every agent gets paid or nothing moves. There is no solver and no spread. The matcher's fee is its own intent inside the same batch, and the matcher runs on the Verifier's shard.

**Network: NEAR testnet only.** `intents.near` exists only on mainnet, so we built the near/intents Verifier (defuse contract) and deployed it ourselves at `intents.nomadswarm.testnet`. All rings settle there. Mainnet is used only for read-only view calls and 1Click dry quotes, which serve as the price baseline.

## Try it in 3 minutes (no keys, no funds)

| Step | Command | You should see |
|---|---|---|
| 1 | `make sim` | `settled TBD rings (k=2..5), cleared TBD % of offers, saved TBD bps vs 1Click baseline`, plus plots in `out/` |
| 2 | `make dry-run` | `simulate_intents` on `intents.nomadswarm.testnet` for `fixtures/rings/ring-3.json`: TBD `intents_executed` (3 agents + matcher) |
| 3 | `npx colo where intents-matcher.nomadswarm.testnet` | the matcher's shard and the Verifier's shard, read from the live layout |
| 4 | `cd web && npm install && npm run dev` | the UI at http://localhost:3000. With no `MATCHER_URL` set, it shows a fixture labelled **MOCK DATA**. Press **d** (or ▶ Play 60s demo) for the 60-second replay |
| 5 | Testnet proof | the tx links under [Deployments](#deployments) |

Unit and property tests: `pnpm install && pnpm test`.

## Feature → file → test

| Feature | File | Test |
|---|---|---|
| Ring search, fee-correct sizing, surplus split | [packages/ringfinder/src/index.ts](packages/ringfinder/src/index.ts) | [packages/ringfinder/test/ringfinder.test.ts](packages/ringfinder/test/ringfinder.test.ts) (property tests) |
| An agent never signs below its limit | [apps/agent/src/legCheck.ts](apps/agent/src/legCheck.ts) | [apps/agent/test/legCheck.test.ts](apps/agent/test/legCheck.test.ts) |
| Agent strategies | [apps/agent/src/strategies.ts](apps/agent/src/strategies.ts) | [apps/agent/test/strategies.test.ts](apps/agent/test/strategies.test.ts) |
| Matcher loop: propose → collect → simulate → execute | [apps/matcher/src/matcher.ts](apps/matcher/src/matcher.ts) | [apps/matcher/test/matcher.test.ts](apps/matcher/test/matcher.test.ts) (end-to-end) |
| NEP-413 leg signing, versioned nonce | [packages/intents/src/nep413.ts](packages/intents/src/nep413.ts), [nonce.ts](packages/intents/src/nonce.ts) | *in progress*: golden vectors + testnet `simulate_intents` |
| Matcher on the Verifier's shard | [packages/colo/src](packages/colo/src) (CLI, library, MCP tool) | [packages/colo/test](packages/colo/test) |
| Offer board (rules in [RULES.md](RULES.md)) | [contracts/board/src/lib.rs](contracts/board/src/lib.rs) | `cargo test` (*in progress*) |
| Local Verifier model + differential test | `packages/verifier-model` (*in progress*) | model vs testnet `simulate_intents` on N random batches |
| 1Click baseline and fallback | `packages/oneclick` (*in progress*) | |
| Atomic settlement under attack | `apps/matcher` | attack: an agent spends first, so the whole ring fails (*in progress*) |
| UI: ring graph, rings table, swarm and race panels | [web/components](web/components), API shape in [web/lib/types.ts](web/lib/types.ts) | `cd web && npm run build` |

## What is real vs simulated

| Part | Real | Simulated |
|---|---|---|
| Settlement | `execute_intents` on our testnet Verifier deployment, real signatures, real testnet tokens | `make sim` uses the local Verifier model, with no chain |
| Tokens | Test NEP-141 tokens on testnet (wNEAR, USDC, USDT, BTC, ZEC stand-ins) | They have no market value |
| Prices and the 1Click baseline | Live mainnet 1Click dry quotes (read-only, no funds) | The ring itself trades testnet tokens at those prices |
| Agents | `aNN.nomadswarm.testnet` sub-accounts, each with its own Verifier key | Sim agents are in-process |
| UI | Reads the matcher's `/api/state` | With no matcher configured, a fixture labelled MOCK DATA |
| Fallback execution through 1Click | Not on testnet (1Click is mainnet-only). `FALLBACK_LIVE=0` | Quotes only |

## NEAR primitives used, and why

- **`execute_intents` on the Intents Verifier.** It takes many signers' intents in one call, checks that each token's diffs net to zero, and commits all of them or none. That is the whole atomic ring. We need no escrow contract of our own.
- **`simulate_intents`.** A free view call. The matcher dry-runs every ring before it submits, and anyone can replay our fixtures with no key.
- **NEP-413 signed `token_diff` intents.** Each agent signs one exact diff: −give, +get. The matcher can't alter a leg without breaking its signature.
- **Verifier fee rule.** Each negative delta pays `ceil(|d| · fee / 1e6)`. The receiver gets `x − fee`, and ring sizing accounts for it ([BUILD_PLAN C1](docs/BUILD_PLAN.md#3-verified-facts-that-correct-the-spec)).
- **Sub-accounts.** One per agent (`a01.nomadswarm.testnet` …), each registering its intents key with `add_public_key`.
- **The shard layout.** An account's name decides its shard. A transaction to the Verifier sent from the Verifier's own shard executes a block sooner. `colo` picks a matcher name on that shard and checks it at start-up.
- **Function-call keys.** Agents' board keys can post and cancel offers but can't move funds.

## Measurements

All figures go in [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md), with tx hashes:

- Kill tests K1–K8 on our testnet Verifier: a 3-signer ring in one call, gas by ring length, `add_public_key`, the fee rule, deposits, deadlines.
- Blocks to execute: matcher on the Verifier's shard vs a control matcher on another shard. TBD.
- The race: win share. TBD.
- The sim sweep: clearing rate by agent count. TBD.

On mainnet, before this build, we measured that transactions to `intents.near` sent from its own shard executed in the inclusion block (27/27), and transactions from another shard one block later (3/3) (`docs/spec/supplementary/probes/data/`). We repeat the measurement on testnet for our own matcher.

## Deployments

| What | Account (testnet) |
|---|---|
| Verifier (near/intents defuse, our build) | `intents.nomadswarm.testnet` |
| Offer board | `board.nomadswarm.testnet` |
| Matcher (on the Verifier's shard) | TBD (named by `colo place`) |
| Control matcher (race) | `matcher.nomadswarm.testnet` |
| Agents | `a01` … `a12` `.nomadswarm.testnet` |
| UI | TBD (Vercel) |

Ring settlements (testnet explorer links): TBD.

## Threat model and known limits

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). In short:
- the matcher can take only what is left after every agent's signed amount;
- a ring with an unfunded or altered leg fails as a whole;
- a leaked agent key loses that agent's (tiny) inventory.

Only assets held inside the Verifier can be in a ring. How often rings occur in a real agent economy is unproven, so the sim shows clearing rate against agent count instead.

## Prior art, and how we differ

Details are in [docs/PRIOR_ART.md](docs/PRIOR_ART.md).

- **CoW Protocol** (Ethereum). Solvers find coincidences of wants, including rings, and settle them through CoW's own settlement contract. Nomad uses the same economic idea with no solver auction and no settlement contract of its own: agents find and sign the loop, and the Intents Verifier enforces the zero-sum.
- **Terra matcher** ([repo](https://github.com/archtum66-dev/terra-matcher)). An off-chain order matcher whose fills are pairs of `token_diff` intents, each party signing its own half, with real mainnet settlements. It is pairwise and for human limit orders. Nomad clears agent loops of k = 2 to 5.
- **NEAR CLEARLOOP** ([repo](https://github.com/Subash-2207/near-clearloop)) and **Deloop**. They net *debts* between businesses in one asset. Nomad swaps *held assets* across tokens between agents, through Intents.
- **Solvers already submit multi-signer batches** to `intents.near` on mainnet (e.g. tx `86bq2zQ2hCXTJVmLj3LTzZNLD7NrzniNBvYpQvHunqF3`, 3 signers). Multi-party atomic batches are not new. Our claim is narrower: agents find and settle loops among themselves, with no solver in the middle.
- Swarm markets in the same hackathon (Flock, SealedSwarm and others) run auctions or pool demand. Nomad clears barter loops.

## Built during NEAR HACKATHON

All code in this repo was written during the hackathon, with AI coding assistants used throughout. Libraries are listed in each `package.json` and `Cargo.toml`. The Intents Verifier is upstream code from [near/intents](https://github.com/near/intents), which we build and deploy to testnet; it is not our work.

## License

MIT, see [LICENSE](LICENSE).
