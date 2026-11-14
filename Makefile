# Nomad: agents trade in rings, settled in one NEAR Intents call.
# NEAR testnet only. Nothing here sends a mainnet transaction.
#
#   make demo       ONE keyless end-to-end check (~1-2 min): sim, dry-run, mainnet proof, on-chain ring check
#   make sim        no chain, no keys: seeded swarm, summary line + out/*.svg
#   make dry-run    simulate_intents on our testnet Verifier for fixtures/rings/*.json (no keys)
#   make test       unit, property and end-to-end tests (TS + Rust)
#   make ui         Next.js UI on :3000 (reads MATCHER_URL, else recorded real testnet data, labelled)
#   make live       matcher + agents on testnet (needs keys from `make accounts`)
#   make race       two matchers (Verifier's shard vs another shard) on the same offers
#   make fixtures   sign fresh demo rings for dry-run
#   make kill-tests K1..K8 against the testnet Verifier (needs the team's testnet keys)

SHELL := /bin/bash
NODE_OPTIONS ?= --dns-result-order=ipv4first
export NODE_OPTIONS

AGENTS ?= 20
TOKENS ?= 5
SEED ?= 1
ROUNDS ?= 30
SWEEP ?= 1
PORT ?= 8787
TSX := pnpm exec tsx

.PHONY: help demo install build test test-ts test-rust test-sandbox sim sim-serve dry-run ui live race fixtures race3 relayer-key ui-check mainnet-proof fee-race kill-tests accounts fund fixture-accounts colo-check clean

help:
	@sed -n '1,/^$$/p' Makefile

node_modules/.modules.yaml: package.json pnpm-workspace.yaml
	pnpm install

install: node_modules/.modules.yaml

build: install
	pnpm -r --filter "./packages/*" --filter "./apps/*" build

test: test-ts test-rust

test-ts: build
	pnpm -r --filter "./packages/*" --filter "./apps/*" test

# Board unit tests (no wasm needed). The near-workspaces sandbox test needs the wasm and cargo-near: `make test-sandbox`.
test-rust:
	cd contracts/board && cargo test --quiet --lib
	cd contracts/rings && cargo test --quiet
	cd contracts/mandate && cargo test --quiet

test-sandbox:
	command -v cargo-near >/dev/null || cargo install cargo-near --version 0.23.0 --locked
	cd contracts/board && cargo near build non-reproducible-wasm && cargo test --quiet --test sandbox

# One keyless command for a fresh clone: build, then four checks, each saying what it shows.
demo: build
	@echo; echo "== 1/4 make sim: 20 agents, 5 tokens, no chain. See: rings settled, share of offers cleared by rings"
	@cd apps/matcher && AGENTS=20 TOKENS=5 SEED=1 ROUNDS=30 SWEEP=0 OUT_DIR=$(CURDIR)/out $(TSX) src/cli-sim.ts
	@echo; echo "== 2/4 make dry-run: signed 3/4/5-party rings through simulate_intents on our testnet Verifier (read-only). See: k+1 intents_executed"
	@cd apps/matcher && $(TSX) src/cli-dry-run.ts $(CURDIR)/fixtures/rings
	@echo; echo "== 3/4 make mainnet-proof: a Nomad-signed ring through simulate_intents on MAINNET intents.near (read-only). See: signatures pass, stops at the balance check"
	@cd apps/matcher && $(TSX) ../../scripts/mainnet-simulate.ts
	@echo; echo "== 4/4 on-chain check of ring f5d3e16f (3 wallet standards, closed by a stranger), read from testnet RPC. See: PASS lines"
	@cd apps/matcher && $(TSX) ../../scripts/check-ring.ts
	@echo; echo "demo: all four checks passed. No keys used, no transactions sent."

sim: build
	cd apps/matcher && AGENTS=$(AGENTS) TOKENS=$(TOKENS) SEED=$(SEED) ROUNDS=$(ROUNDS) SWEEP=$(SWEEP) OUT_DIR=$(CURDIR)/out $(TSX) src/cli-sim.ts

# Continuous sim behind /api/state so the UI runs with no chain (labelled as sim/mock data).
sim-serve: build
	cd apps/matcher && AGENTS=$(AGENTS) TOKENS=$(TOKENS) SEED=$(SEED) SWEEP=0 SERVE=1 PORT=$(PORT) OUT_DIR=$(CURDIR)/out $(TSX) src/cli-sim.ts

dry-run: build
	cd apps/matcher && $(TSX) src/cli-dry-run.ts $(CURDIR)/fixtures/rings

ui:
	cd web && npm install && MATCHER_URL=$${MATCHER_URL:-http://localhost:$(PORT)} npm run dev

# Local UI check: sim matcher + a web/ dev instance (not the deployed UI) + headless screenshot.
ui-check: build
	./scripts/ui-check.sh

accounts: build
	cd apps/matcher && $(TSX) src/cli-accounts.ts

fund: build
	cd apps/matcher && $(TSX) src/cli-fund.ts

live: build
	cd apps/matcher && PORT=$(PORT) $(TSX) src/cli-live.ts

race: build
	cd apps/matcher && RACE=1 PORT=$(PORT) $(TSX) src/cli-live.ts

# 3-way race: + a matcher that submits as the Verifier through a delegated execute_intents key
race3: build
	cd apps/matcher && RACE=3 PORT=$(PORT) $(TSX) src/cli-live.ts

# Fee competition: three matchers (35% / 20% / 5% of surplus) with equal speed; agents auction each offer.
fee-race: build
	cd apps/matcher && RACE=3 FEE_RACE=1 RACE_PHI=$${RACE_PHI:-0.35,0.2,0.05} AUCTION_MS=$${AUCTION_MS:-400} MAX_ROUNDS=$${MAX_ROUNDS:-4} PORT=$(PORT) $(TSX) src/cli-live.ts

relayer-key: build
	cd apps/matcher && $(TSX) src/cli-relayer-key.ts

# Fixture agents fx01..fx12 are separate from the live agents, so live trading never drains them.
fixture-accounts: build
	cd apps/matcher && AGENT_PREFIX=fx AGENT_NEAR=0.15 SKIP_BOARD_KEYS=1 $(TSX) src/cli-accounts.ts && AGENT_PREFIX=fx SKIP_BOARD=1 FUND_USD=0.75 $(TSX) src/cli-fund.ts

fixtures: build
	cd apps/matcher && AGENT_PREFIX=fx $(TSX) src/cli-fixtures.ts $(CURDIR)/fixtures/rings

kill-tests: build
	for k in scripts/k*.ts; do echo "== $$k"; (cd apps/matcher && $(TSX) ../../$$k) || exit 1; done

# Read-only mainnet proof: our signer's 3-agent ring against intents.near simulate_intents (no keys, no funds).
mainnet-proof: build
	cd apps/matcher && $(TSX) ../../scripts/mainnet-simulate.ts

colo-check: build
	node packages/colo/dist/cli.js check --account $${MATCHER_ID:-intents-matcher.nomadswarm.testnet} --target $${VERIFIER_ID:-intents.nomadswarm.testnet} --network testnet

clean:
	rm -rf out/*.svg out/*.json packages/*/dist apps/*/dist
