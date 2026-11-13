#!/usr/bin/env bash
# Build the House of Stake TLA contracts from UNMODIFIED upstream source
# (houseofstake/tla-contracts), pinned to commit d85860a ("Cleanup", 2026-10-15; still HEAD of main on 2026-11-14).
#
# Only hos_wallet.wasm is deployed by scripts/hos-budget.ts; the rest are built so the
# full-stack cost estimate in docs/HOS_BUDGETS.md is measured, not guessed.
#
# Our host build (aarch64-apple-darwin, cargo-near 0.23.0, rust 1.97.1 pinned by upstream):
#   hos_wallet.wasm            432,939 bytes
#   tla_registry.wasm          658,995 bytes
#   hos_extension.wasm         289,444 bytes
#   registrar.wasm             188,180 bytes
#   wallet_impl_deployer.wasm  169,695 bytes
# A docker reproducible-wasm build gives different hashes; the script prints the sha256 it deploys.
#
# Output: $SRC/target/near/<name>/<name>.wasm   (SRC defaults to /tmp/hos/tla-contracts)
set -euo pipefail
SRC=${SRC:-/tmp/hos/tla-contracts}
COMMIT=d85860a8cc2bfcb8b617b28cab558da5d39333fc
CONTRACTS=(hos-wallet wallet-impl-deployer registrar hos-extension tla-registry)

if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/houseofstake/tla-contracts "$SRC"
fi
git -C "$SRC" fetch --quiet origin 2>/dev/null || true
git -C "$SRC" checkout --quiet "$COMMIT"
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "refusing to build: $SRC has local changes (we build unmodified upstream source)" >&2
  exit 1
fi

command -v cargo-near >/dev/null || { echo "cargo-near is required (cargo install cargo-near --locked)" >&2; exit 1; }
# rust-toolchain.toml in the repo pins 1.97.1 + wasm32-unknown-unknown; rustup installs it on first use.
for c in "${CONTRACTS[@]}"; do
  echo "== $c"
  (cd "$SRC/contracts/$c" && cargo near build non-reproducible-wasm --locked --no-abi)
done
for c in "${CONTRACTS[@]}"; do
  n=${c//-/_}
  f="$SRC/target/near/$n/$n.wasm"
  printf '%-28s %9s bytes  sha256 %s\n' "$n.wasm" "$(wc -c <"$f" | tr -d ' ')" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
done
