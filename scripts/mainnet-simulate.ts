// Mainnet proof, read-only: sign a 3-agent ring with Nomad's own signer (@nomad/intents) for mainnet
// intents.near and run simulate_intents (a view call: no key, no deposit, nothing is sent).
// The agents are fresh implicit accounts (no registration needed), so the expected result is
// that signatures, the versioned nonce and the salt are all accepted and execution stops only at
// the balance check ("insufficient balance or overflow"). Controls: a corrupted signature must fail
// earlier with "invalid signature", and a zero-salt nonce with "invalid salt".
// Our testnet Verifier runs the same bytes as intents.near (code hash BtA1BEFN…), so this ties the
// testnet results to mainnet behaviour. Output: docs/measurements/mainnet-simulate.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { IntentsClient, NearRpc, randomKeyPair, implicitAccountId, signTokenDiff, buildNonce } from "../packages/intents/src/index.js";
import { feeOf } from "../packages/ringfinder/src/index.js";

const rpc = new NearRpc("https://free.rpc.fastnear.com", ["https://rpc.mainnet.fastnear.com"]);
const intents = new IntentsClient({ rpc, verifierId: "intents.near" });
const W = "nep141:wrap.near", U = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", Z = "nep141:zec.omft.near";

const fee = await intents.fee();
const salt = await intents.currentSalt();
const deadline = new Date(Date.now() + 10 * 60_000);
const agents = [randomKeyPair(), randomKeyPair(), randomKeyPair()].map((kp) => ({ kp, id: implicitAccountId(kp.publicKey) }));

// a01 gives 1 wNEAR wants USDC; a02 gives USDC wants ZEC; a03 gives ZEC wants wNEAR. Receivers get x - fee (BUILD_PLAN C1).
const x = [10n ** 24n, 3_400_000n, 360_000n];
const tok = [W, U, Z];
const legs = agents.map((a, i) => {
  const give = tok[i]!, get = tok[(i + 1) % 3]!, nextGive = x[(i + 1) % 3]!;
  return { a, diff: { [give]: (-x[i]!).toString(), [get]: (nextGive - feeOf(nextGive, fee)).toString() } };
});
const sign = (l: (typeof legs)[number], nonce?: Uint8Array) =>
  signTokenDiff({ signerId: l.a.id, secretKey: l.a.kp.secretKeyStr, verifierId: "intents.near", salt, deadline, diff: l.diff, nonce });

const ring = legs.map((l) => sign(l));
// payloads are checked in order, so corrupt the FIRST one (a later one would never be reached: the first
// valid leg already stops at the balance check)
const corrupted = ring.map((p, i) => (i === 0 ? { ...p, signature: ring[1]!.signature } : p));
const zeroSalt = legs.map((l) => sign(l, buildNonce("00000000", deadline)));

const run = async (name: string, signed: unknown[]) => {
  const r = await intents.simulate(signed as never);
  return { name, ok: r.ok, errorClass: r.errorClass ?? null, error: (r.error ?? "").slice(0, 160) };
};
// The Verifier checks payloads in order and stops at the first failure, so one run only proves the first
// leg's signature. Run the ring three times, rotated, so every agent's signed leg is checked first once.
const rotations = [0, 1, 2].map((r) => [...ring.slice(r), ...ring.slice(0, r)]);
const results = [
  ...(await Promise.all(rotations.map((rot, r) => run(`ring (3 agents), leg ${r + 1} first`, rot)))),
  await run("control: corrupted signature", corrupted),
  await run("control: zero salt", zeroSalt),
];
const pass =
  results.slice(0, 3).every((r) => r.errorClass === "insufficient balance or overflow") &&
  results[3]!.errorClass === "invalid signature" &&
  results[4]!.errorClass === "invalid salt";

const out = {
  measuredAt: new Date().toISOString(),
  network: "mainnet (read-only simulate_intents)",
  verifier: "intents.near",
  feePips: fee,
  currentSalt: salt,
  agents: agents.map((a) => a.id),
  legs: legs.map((l) => ({ agent: l.a.id, diff: l.diff })),
  results,
  verdict: pass
    ? "PASS: for each of the 3 agents' legs (each run once in first position), mainnet intents.near accepts Nomad's NEP-413 signature, versioned nonce and salt and stops only at the balance check (the implicit accounts are unfunded). The controls fail where expected: corrupted signature -> invalid signature, zero salt -> invalid salt."
    : "UNEXPECTED: see results",
};
fs.mkdirSync(path.join(ROOT, "docs/measurements"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs/measurements/mainnet-simulate.json"), JSON.stringify(out, null, 1));
for (const r of results) console.log(`${r.name}: ${r.ok ? "ok" : r.errorClass}`);
console.log(out.verdict);
process.exit(pass ? 0 : 1);
