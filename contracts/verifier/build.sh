#!/usr/bin/env bash
# Reproduce our testnet Verifier wasm: near/intents defuse 0.4.5 (commit 16d04f6, the version
# intents.near runs on mainnet), built from UNMODIFIED upstream source with cargo-near.
# Output: $SRC/target/near/defuse/defuse.wasm. Our build: 1,288,007 bytes,
# sha256 hex cb632a6902dd16320d061d11f2bcf05ad6169824b069600cea71d3f0237daedf
# (host build on aarch64-apple-darwin; a docker reproducible build would give a different hash).
set -euo pipefail
SRC=${SRC:-/tmp/nirsrc/intents-045}
COMMIT=16d04f6ec4401263f8914638710260da50bb46b0
CARGO_NEAR_VERSION=0.23.0

if [ ! -d "$SRC/.git" ] && [ ! -f "$SRC/.git" ]; then
  git clone https://github.com/near/intents "$SRC"
fi
git -C "$SRC" fetch --quiet origin "$COMMIT" 2>/dev/null || true
git -C "$SRC" checkout --quiet "$COMMIT"

if ! command -v cargo-near >/dev/null || ! cargo near --version | grep -q "$CARGO_NEAR_VERSION"; then
  # Prebuilt binary from the cargo-near release (or: cargo install cargo-near --version $CARGO_NEAR_VERSION --locked)
  curl --proto '=https' --tlsv1.2 -LsSf "https://github.com/near/cargo-near/releases/download/cargo-near-v$CARGO_NEAR_VERSION/cargo-near-installer.sh" | sh
fi

# rust-toolchain in the repo pins 1.97.1 + wasm32-unknown-unknown; rustup installs it on first use.
cd "$SRC"
cargo near build non-reproducible-wasm --locked --no-abi \
  --manifest-path contracts/defuse/Cargo.toml \
  --features contract --abi-features abi,contract
shasum -a 256 target/near/defuse/defuse.wasm
