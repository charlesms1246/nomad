# Nomad

**Agents and wallets trade in rings that settle atomically on NEAR Intents. Each one signs only its own leg, and anyone can close the ring.**

A has USDC and wants wNEAR, B has wNEAR and wants ZEC, and C has ZEC and wants USDC. No two of them can trade as a pair, but the three can trade as a ring. Nomad finds rings like this, collects one signed leg from each participant, and settles the ring in a single `execute_intents` call on the NEAR Intents Verifier. Either every leg settles or none does.

Tracks: **AI Swarms** and **DeFi**. Network: **NEAR testnet**.

**Live:**
- https://nomad.charlesms.dev replays a real three-wallet ring step by step, from proposal to tips. It reads the ring from testnet in your browser.
- https://nomad.charlesms.dev/v2?verify=1 lists every on-chain ring and checks each close on chain as the page loads.
- https://nomad.charlesms.dev/dashboard shows the off-chain matcher swarm: the ring graph, rings, agents and races. It plays back real testnet data that we recorded.

## What Nomad does

- **Rings of 2–5 parties.** A ring finder sizes each ring so that every token nets to zero after the Verifier fee, and so that every party gets at least its limit price.
- **Permissionless close.** `rings.nomadswarm.testnet` lets anyone call `propose_ring`. Each party then attaches its signed leg with `attach_leg`, and **any account** can call `close_ring`. The contract makes one cross-contract `execute_intents` call and pays the closer the tips that the parties signed. Nobody needs an allowlist, and no matcher takes a cut.
- **Any wallet.** One ring can mix legs signed under `nep413` (NEAR), `erc191` (Ethereum `personal_sign`) and `raw_ed25519` (Solana-style keys).
- **ERC-7683 orders.** An Ethereum wallet signs an EIP-712 `GaslessCrossChainOrder` once. `submit_order` checks the order on chain with `ecrecover`, and the contract then enforces the order's minimum price on every ring that includes that wallet.
- **On-chain mandates.** `mandate.nomadswarm.testnet` controls an Ethereum-style account. No hot key holds it. For each leg, the contract checks the owner's limits: allowed tokens, the maximum per leg, a daily budget and a minimum price. It then asks NEAR Chain Signatures (MPC) to sign the leg.
- **Reputation.** The rings contract keeps counters for each account: rings settled, rings closed, and legs that were in a failed close.
- **One-of-N commitments.** Every leg that a party signs for a given offer uses the same Verifier nonce, so at most one of those legs can ever execute. This holds even when the party has open legs in several rings or competing proposals.
- **Agent swarm (off-chain mode).** Twelve agents post offers to a board contract. Matchers find rings and propose them, and the agents run an auction so that matchers compete on their fee. An agent checks every proposal with `legCheck` before it signs.

## Proof on testnet

Every link below goes to NearBlocks.

| What | Tx |
|---|---|
| A stranger (`k4`, not a party to the ring) closes a ring whose legs use three wallet standards (`nep413` + `erc191` + `raw_ed25519`). Each wallet gave 1,000,000 plus a 1,000 tip and received 999,999. The closer received the three tips | [`GALT4S7B…`](https://testnet.nearblocks.io/txns/GALT4S7BiENHVroypTv1uQmanBAmhm9uSXbyHpShD7hR) |
| A stranger closes a three-agent ring. One cross-contract `execute_intents` call settles it, and the closer receives exactly the three tips | [`85Emngj6…`](https://testnet.nearblocks.io/txns/85Emngj6B4q8EqSjAWShfPbMYSfrGstE9RnYJwrhVQdc) |
| An ERC-7683 order from a fresh Ethereum wallet is checked on chain | [`DGMvefCs…`](https://testnet.nearblocks.io/txns/DGMvefCsuZuuzoSs6iqqkkMFjpGYhPPnAjAab1VzgkhV) |
| A ring that pays that wallet less than its minimum price is rejected | [`GvZcdEY5…`](https://testnet.nearblocks.io/txns/GvZcdEY5LPHfxxJ6M67ijEyVPhAbwE9ZrFdAZaLHXzFF) |
| A ring at the order's price settles, and the order shows 399,495 of 1,000,000 filled | [`D6YZJqgr…`](https://testnet.nearblocks.io/txns/D6YZJqgrEVXXNVLahodBycyBBqNV1RnwnY6ptAyCRhCK) |
| A leg signed by the mandate through Chain Signatures settles in a ring that a stranger closed. The MPC request ([`J89CLaPP…`](https://testnet.nearblocks.io/txns/J89CLaPPRsbuQ4nNqXTqdNXJnXu8GmzZcvjFWxqUkW7A)) took 9.2 s | [`2WgJbhRW…`](https://testnet.nearblocks.io/txns/2WgJbhRWZJhy38nCxSLeb2FPXCN4SaX9TmvhakBcPrr9) |
| The mandate refuses a leg below its minimum price | [`GJXuiUZF…`](https://testnet.nearblocks.io/txns/GJXuiUZF1HvDVbCjMp49fDRhrK8JLYAj5LMmJrNSbPUg) |
| The mandate refuses a leg over its daily budget | [`Ht9SdVao…`](https://testnet.nearblocks.io/txns/Ht9SdVaozyEKSoYtAU398TVNaZM7JfEUe6rcvQhQk8DU) |
| The three wallet standards settle together directly through `execute_intents` | [`EpaBq8dN…`](https://testnet.nearblocks.io/txns/EpaBq8dN8WhojK4eo1fqZ7XRBMXuGBdjv4G8bu5r379x) |
| A 36-minute live swarm run with 12 agents: **27 rings settled, 0 failed** (k = 3: 4, k = 4: 17, k = 5: 6), at about 15.1 Tgas per ring | [`Fd5Q86nQ…`](https://testnet.nearblocks.io/txns/Fd5Q86nQS8qmn4aQz7of5vXXUx86sscwNpFa5J1sPoCw) (k = 4), [`EqLHddfT…`](https://testnet.nearblocks.io/txns/EqLHddfTmLVHUVgE5MUZcfgT56SfLCWSr4nBFdWSPso3) (k = 5) |
| A fee race: three matchers propose on the same rings. The 5% matcher won all 7 settled rounds | [`9jZc4meP…`](https://testnet.nearblocks.io/txns/9jZc4meP5XmsexNNDQ1oav18AsX3AuxxVR4xtPYdzrxH) |
| A three-agent ring settles in one receipt, burning 11.36 Tgas | [`BgjzT1Va…`](https://testnet.nearblocks.io/txns/BgjzT1VayBzmvfuqx29pmBnj1tzS1M7hxkXJ3sigVRKE) |

### Attacks, each submitted for real

`scripts/attacks.ts` submits each attack as a real `execute_intents` call. A row passes only if the batch fails with the expected error and none of the balances it watches moves. All rows pass.

| Attack | Verifier error | Tx |
|---|---|---|
| A party spends its balance before settlement | `insufficient balance or overflow` | [`DzrAU1T9…`](https://testnet.nearblocks.io/txns/DzrAU1T9x7AzDtR627PYM6ZwkVkWLQG6nASP7rLxTG6e) |
| The submitter inflates its own leg | `invariant violated` | [`73Loxt2m…`](https://testnet.nearblocks.io/txns/73Loxt2m5bqMCMcdcLoKeDc6LFNLfrBco9QipALs9vbq) |
| The submitter alters a signed leg | `invalid signature` | [`6AkUyrhB…`](https://testnet.nearblocks.io/txns/6AkUyrhBd1FdXmfNyuvsFeCtwoLapzM7YZLJBjBiJJu5) |
| Legs that already settled are replayed | `nonce was already used` | [`BMGqwEJM…`](https://testnet.nearblocks.io/txns/BMGqwEJMrWqvopvNZHhTLDHQkdWK2dFGmihFzrPnHcCL) |
| A stale salt / a zero salt | `invalid salt` | [`Hz66pPd2…`](https://testnet.nearblocks.io/txns/Hz66pPd2YyKSNV1w4f2D8TsPfsAxf5smfQpUNbHLZW7M), [`76zPf4fS…`](https://testnet.nearblocks.io/txns/76zPf4fS1nUiWQbb5AQGcFD84Rb9tZKeAPeKQucXXL3G) |
| A leg with a zero amount | `invalid intent` | [`77LKZyzq…`](https://testnet.nearblocks.io/txns/77LKZyzqjMRKdjqKyE7AFYJWpRaJe2bQbuRUG5PNeCo1) |
| Two rings race for one offer that has one shared nonce | The loser fails with `nonce was already used` | [`FRZFAP9F…`](https://testnet.nearblocks.io/txns/FRZFAP9FRzdWru41cfJw9jgC7SYwugnWHZMxSmRR4PVs) |

In a three-way race of matchers, all 54 losing batches failed with `nonce was already used`, and none of them moved a balance.

### Our testnet Verifier is mainnet's exact code

`intents.near` exists only on mainnet. Our Verifier, `intents.nomadswarm.testnet`, runs the same wasm as mainnet `intents.near`, and its FullAccess key has been deleted. You can compare the two code hashes yourself:

```sh
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.near"}}' | grep -o '"code_hash":"[^"]*"'
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.nomadswarm.testnet"}}' | grep -o '"code_hash":"[^"]*"'
```

Both commands print `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`.

`make mainnet-proof` signs a three-party ring for mainnet `intents.near` and runs it through the read-only `simulate_intents` view. Each leg passes the signature, nonce and salt checks and stops only at the balance check, because the accounts are unfunded. A corrupted signature fails with `invalid signature`. No mainnet transaction is sent.

## Architecture

```
 wallets / agents ──sign own leg──►  rings.nomadswarm.testnet  ──execute_intents──►  intents.nomadswarm.testnet
 (nep413, erc191,                    propose_ring · attach_leg                       (NEAR Intents Verifier:
  raw_ed25519, EIP-712)              close_ring (anyone) · submit_order               all legs or none)
                                     reputation
 mandate.nomadswarm.testnet ──Chain Signatures (v1.signer-prod.testnet)──► erc191 leg
 board.nomadswarm.testnet ◄── offers ── agents ◄── proposals ── matchers (off-chain mode) ──► execute_intents
```

| Part | Path | What it is |
|---|---|---|
| Rings contract | `contracts/rings` | The ring proposal, the leg checks, permissionless close, tips, reputation and ERC-7683 orders. 16 Rust tests |
| Mandate contract | `contracts/mandate` | Limits on each leg, MPC signing and an `ecrecover` check. 14 Rust tests |
| Offer board | `contracts/board` | Offers with a TTL and a storage deposit, plus pruning. 40 Rust tests |
| Intents client | `packages/intents` | NEP-413, `erc191`, `raw_ed25519` and ERC-7683 signing, the Verifier client and the RPC client with fallback. Golden vectors |
| Ring finder | `packages/ringfinder` | Cycle search, sizing that accounts for the fee, and the surplus split. Property tests |
| Verifier model | `packages/verifier-model` | A local model of the Verifier. It agrees with testnet `simulate_intents` on 500 of 500 random batches |
| Agents | `apps/agent` | `legCheck` (never signs outside its offer), strategies, the fee auction, an MCP server (`nomad-mcp`) and an optional LLM that sets margins |
| Matcher | `apps/matcher` | Propose, collect, simulate, execute. Also the simulator and a read-only `/api/state` container |
| Web | `web` | The landing page with the ring replay, `/v2` with on-chain checks, and `/dashboard` |

Kill tests K1–K8 (`make kill-tests`, needs keys) pin down the Verifier behaviour that Nomad depends on: one receipt per ring, the fee rule `ceil(|d|·fee/1e6)`, gas of about 3.25 + 2.53 Tgas per signer, the 1-yocto `add_public_key`, how deposits are routed, deadlines and salts.

## Quick start

You need Node 20 or later and pnpm 9 (`corepack enable` picks up the version pinned in the repo). `make test` also needs Rust. The commands below need no keys and no funds.

```sh
pnpm install          # "Failed to create bin" warnings on a fresh clone are harmless
make test             # TypeScript packages plus the Rust contracts (board 40, rings 16, mandate 14)
make sim              # 20 agents, 5 tokens: rings settled, share of offers cleared, saving vs a 1Click quote
make dry-run          # signed ring fixtures through simulate_intents on our testnet Verifier
make mainnet-proof    # the read-only signature proof against mainnet intents.near
cd web && npm install && npm run dev   # http://localhost:3000, /v2?verify=1, /dashboard
```

With keys for the `nomadswarm.testnet` accounts, these targets run against testnet:
- `make live` runs the agent swarm and a matcher.
- `make fee-race` runs matchers that compete on their fee.
- `make race3` runs a three-way race for the same rings.
- `make kill-tests` runs K1–K8.

`make ui-check` takes screenshots of every page at 1440 px and 390 px.

## Deployments (testnet)

| Contract | Account | Notes |
|---|---|---|
| Rings | `rings.nomadswarm.testnet` | No access keys. Code hash `FWgwBLpsVax1iRF3jC6QcM3XJEiJXjDCR3oCRFr1uHLc`. The owner can change only the fee setting and the EIP-712 chain id (now 1 pip and 398) |
| Mandate | `mandate.nomadswarm.testnet` | No access keys. Code hash `7ufPqdBa1NYbhkbPHQ8Ub9FY9AzRpTsF2UTt5F1sYNTT`. MPC account `0x991543dd33bcf06563cd14a67decf1834fe6bf9b` |
| Verifier | `intents.nomadswarm.testnet` | Mainnet `intents.near`'s exact wasm. Fee of 1 pip. No FullAccess key. The in-contract admin roles belong to `nomadswarm.testnet`, which can still upgrade the code |
| Offer board | `board.nomadswarm.testnet` | Off-chain-mode offers |
| Test tokens | `wnear`, `usdc`, `usdt`, `btc`, `zec` `.nomadswarm.testnet` | No market value |
| Agents | `a01`–`a12.nomadswarm.testnet` | Each agent has its own Verifier key |

## Limits

- **Testnet only.** No funded ring has settled on mainnet. The tokens have no market value, and every ring so far has run between our own agents and test wallets.
- **Demand is unproven.** The simulator's offers are random. It clears 44–50% of offers by rings at any swarm size from 10 to 200 agents, which says nothing about real flow. Rings probably suit trades that can wait.
- **Savings are small.** In the live run, the agents beat a same-time 1Click mainnet quote by a mean of +20.5 bps. Most of that is 1Click's 20 bps keyless app fee. Without it, the saving is about +0.5 bps.
- **Off-chain matchers take a cut.** At φ = 0.2, the median was 61 bps of the leg that pays it. With three competing matchers that we ran ourselves, it fell to 14.8 bps. On-chain closing has no cut, only the tips that the parties sign (0.1% in our runs).
- **Speed.** Contract closing settles 2 blocks after `close_ring`. Only a transaction signed by the Verifier account itself executes in the block it lands in, so only the Verifier operator can get same-block settlement.
- **Mandates.** Each signature costs about 0.01 NEAR and takes about 9 s. The budget is charged at signing, not at settlement. `min_counterparty_reputation` is stored but not enforced.
- **Trust.** You must trust the Verifier's admin roles (held by our team on testnet), the mandate code, the MPC network and NEAR consensus. Both contracts were built with a non-reproducible `cargo near` build, so rebuilding them from source may not match the code hashes byte for byte.
- **Only assets inside the Verifier** can go into a ring. The 1Click fallback is quote-only on testnet.
- **Unaudited.**

## Built with

NEAR Intents (`execute_intents`, `simulate_intents`), NEAR Chain Signatures, `near-sdk`, `@noble/curves`, `@noble/hashes`, `ws`, `@modelcontextprotocol/sdk`, `zod`, `vitest`, `fast-check`, Next.js and Tailwind CSS. Built for NEAR HACKATHON 2026, with AI-assisted coding (Claude Code).

## License

MIT. See [LICENSE](LICENSE).
