# Nomad: agents trade in rings, settled in one NEAR Intents call.
# NEAR testnet only. Nothing here sends a mainnet transaction.
#
#   make sim        no chain, no keys: seeded swarm, summary line + out/*.svg
#   make dry-run    simulate_intents on our testnet Verifier for fixtures/rings/*.json (no keys)
#   make test       unit, property and end-to-end tests (TS + Rust)
#   make ui         Next.js UI on :3000 (reads MATCHER_URL, else a labelled mock)
#   make live       matcher + agents on testnet (needs keys from `make accounts`)
#   make race       two matchers (Verifier's shard vs another shard) on the same offers
#   make fixtures   sign fresh demo rings for dry-run
#   make kill-tests K1..K8 against the testnet Verifier, results -> docs/MEASUREMENTS.md

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

.PHONY: help install build test test-ts test-rust sim sim-serve dry-run ui live race fixtures kill-tests accounts fund colo-check clean

help:
	@sed -n '1,14p' Makefile

node_modules/.modules.yaml: package.json pnpm-workspace.yaml
	pnpm install

install: node_modules/.modules.yaml

build: install
	pnpm -r --filter "./packages/*" --filter "./apps/*" build

test: test-ts test-rust

test-ts: build
	pnpm -r --filter "./packages/*" --filter "./apps/*" test

test-rust:
	cd contracts/board && cargo test --quiet

sim: build
	cd apps/matcher && AGENTS=$(AGENTS) TOKENS=$(TOKENS) SEED=$(SEED) ROUNDS=$(ROUNDS) SWEEP=$(SWEEP) OUT_DIR=$(CURDIR)/out $(TSX) src/cli-sim.ts

# Continuous sim behind /api/state so the UI runs with no chain (labelled as sim/mock data).
sim-serve: build
	cd apps/matcher && AGENTS=$(AGENTS) TOKENS=$(TOKENS) SEED=$(SEED) SWEEP=0 SERVE=1 PORT=$(PORT) OUT_DIR=$(CURDIR)/out $(TSX) src/cli-sim.ts

dry-run: build
	cd apps/matcher && $(TSX) src/cli-dry-run.ts $(CURDIR)/fixtures/rings

ui:
	cd web && npm install && MATCHER_URL=$${MATCHER_URL:-http://localhost:$(PORT)} npm run dev

accounts: build
	cd apps/matcher && $(TSX) src/cli-accounts.ts

fund: build
	cd apps/matcher && $(TSX) src/cli-fund.ts

live: build
	cd apps/matcher && PORT=$(PORT) $(TSX) src/cli-live.ts

race: build
	cd apps/matcher && RACE=1 PORT=$(PORT) $(TSX) src/cli-live.ts

fixtures: build
	cd apps/matcher && $(TSX) src/cli-fixtures.ts $(CURDIR)/fixtures/rings

kill-tests: build
	for k in scripts/k*.ts; do echo "== $$k"; $(TSX) $$k || exit 1; done

colo-check: build
	pnpm --filter @nomad/colo exec colo check --account $${MATCHER_ID:-intents-matcher.nomadswarm.testnet} --target $${VERIFIER_ID:-intents.nomadswarm.testnet} --network testnet

clean:
	rm -rf out/*.svg out/*.json packages/*/dist apps/*/dist
