// Nomad on-chain rings end to end on testnet (kill test K-b):
//   deploy contracts/rings to rings.nomadswarm.testnet (once), then
//   proposer posts a 3-agent ring (no matcher leg; all surplus to the agents) ->
//   each agent signs its own leg (token_diff + a tip transfer to the rings contract) ->
//   a STRANGER account closes it -> one execute_intents via the contract ->
//   tips paid to the stranger by mt_transfer (predecessor auth) -> reputation updated.
// Usage (from apps/matcher): npx tsx ../../scripts/rings-e2e.ts [--deploy] [--closer k4.nomadswarm.testnet]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NearRpc, IntentsClient, signerFor, randomKeyPair, saveCredentials, hasCredentials, signIntents, TESTNET_RPC, TESTNET_RPC_FALLBACKS, ONE_NEAR, TGAS } from "../packages/intents/src/index.js";
import { sizeRing, feeOf, type Offer } from "../packages/ringfinder/src/index.js";
import { limitRate } from "../apps/agent/src/strategies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/testnet.json"), "utf8"));
const RINGS = "rings.nomadswarm.testnet";
const PARENT = "nomadswarm.testnet";
const args = process.argv.slice(2);
const CLOSER = args.includes("--closer") ? args[args.indexOf("--closer") + 1]! : "k4.nomadswarm.testnet";
const rpc = new NearRpc(TESTNET_RPC, TESTNET_RPC_FALLBACKS);
const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
const view = <T>(method: string, a: object = {}) => rpc.view<T>(RINGS, method, a);
const out: Record<string, unknown> = { at: new Date().toISOString(), rings: RINGS, verifier: cfg.verifierId, closer: CLOSER };

if (args.includes("--deploy")) {
  if (!(await rpc.viewAccount(RINGS))) {
    const kp = randomKeyPair();
    const wasm = fs.readFileSync(path.join(ROOT, "contracts/rings/target/near/nomad_rings.wasm"));
    const r = await rpc.sendTx(signerFor(PARENT), RINGS, [
      { type: "CreateAccount" },
      { type: "Transfer", deposit: 3n * ONE_NEAR },
      { type: "AddKey", publicKey: kp.publicKeyStr, permission: "FullAccess" },
      { type: "DeployContract", code: new Uint8Array(wasm) },
      { type: "FunctionCall", methodName: "new", args: { owner_id: PARENT, verifier_id: cfg.verifierId, fee_pips: 1 }, gas: 30n * TGAS, deposit: 0n },
    ]);
    if (!r.ok) throw new Error(`deploy failed: ${r.error}`);
    if (!hasCredentials(RINGS)) saveCredentials({ account_id: RINGS, public_key: kp.publicKeyStr, private_key: kp.secretKeyStr });
    console.log(`deployed ${RINGS}: ${r.txHash}`);
    out.deployTx = r.txHash;
  } else console.log(`${RINGS} exists`);
}

// --- size a ring: a01 ZEC->USDC, a02 USDC->wNEAR, a03 wNEAR->ZEC, $0.30 legs, 1% under mid ---
const tok = (s: string) => cfg.tokens.find((t: { symbol: string }) => t.symbol === s);
const px: Record<string, number> = { wNEAR: 3.45, USDC: 1, ZEC: 939 };
const T = ["ZEC", "USDC", "wNEAR"].map((s) => ({ ...tok(s), priceUsd: px[s]! }));
const agents = ["a01", "a02", "a03"].map((a) => `${a}.${PARENT}`);
const fee = await intents.fee();
const deadline = Date.now() + 10 * 60_000;
const offers: Offer[] = T.map((t, i) => {
  const next = T[(i + 1) % 3]!;
  const r = limitRate(t, next, 0.01);
  const giveMax = BigInt(Math.floor((0.3 / t.priceUsd) * 10 ** Math.min(t.decimals, 15))) * 10n ** BigInt(Math.max(0, t.decimals - 15));
  return { id: `e2e-${i}`, agent: agents[i]!, give: t.id, giveMax, want: next.id, rateNum: r.rateNum, rateDen: r.rateDen, expiresAtMs: deadline };
});
const sized = sizeRing(offers, { feePips: fee, phi: 0, minGiveUnits: 1n });
if (!sized) throw new Error("ring does not clear");
// no matcher leg in on-chain rings: the last agent absorbs the rounding dust (it only gets more)
const legsRaw = sized.legs.map((l, i) => ({ ...l, getAmt: i === sized.legs.length - 1 ? l.getAmt + sized.matcherLeg.amt : l.getAmt }));
const legs = legsRaw.map((l) => ({
  agent: l.agent,
  give: l.give,
  give_amt: l.giveAmt.toString(),
  get: l.get,
  get_amt: l.getAmt.toString(),
  tip: { token: l.give, amt: (l.giveAmt / 1000n > 0n ? l.giveAmt / 1000n : 1n).toString() },
}));
for (const [i, l] of legsRaw.entries()) {
  const nextGive = legsRaw[(i + 1) % legsRaw.length]!.giveAmt;
  if (l.getAmt !== nextGive - feeOf(nextGive, fee)) throw new Error(`leg ${i} does not close`);
}
out.legs = legs;
console.log("ring:", legs.map((l) => `${l.agent.split(".")[0]} -${l.give_amt} ${l.give.split(":")[1]!.split(".")[0]} +${l.get_amt} ${l.get.split(":")[1]!.split(".")[0]} (tip ${l.tip.amt})`).join(" | "));

// --- propose (by intents-matcher-1, any account would do) ---
const proposer = signerFor(`intents-matcher-1.${PARENT}`);
const p = await rpc.sendTx(proposer, RINGS, [{ type: "FunctionCall", methodName: "propose_ring", args: { legs, deadline_ms: deadline }, gas: 50n * TGAS, deposit: ONE_NEAR / 10n }]);
if (!p.ok) throw new Error(`propose failed: ${p.error}`);
const ringId = JSON.parse(p.returnValue!);
console.log(`proposed ${ringId}: ${p.txHash}`);
out.ringId = ringId;
out.proposeTx = p.txHash;

// --- each agent signs its own leg and attaches it ---
const salt = await intents.currentSalt();
out.attachTxs = [];
for (const [i, l] of legs.entries()) {
  const key = JSON.parse(fs.readFileSync(path.join(ROOT, "keys", `${l.agent}.intents.json`), "utf8"));
  const signed = signIntents({
    signerId: l.agent,
    secretKey: key.private_key,
    verifierId: cfg.verifierId,
    salt,
    deadline: new Date(deadline),
    intents: [
      { intent: "token_diff", diff: { [l.give]: `-${l.give_amt}`, [l.get]: l.get_amt } },
      { intent: "transfer", receiver_id: RINGS, tokens: { [l.tip.token]: l.tip.amt } },
    ],
  } as never);
  const a = await rpc.sendTx(signerFor(l.agent), RINGS, [{ type: "FunctionCall", methodName: "attach_leg", args: { ring_id: ringId, index: i, signed: JSON.stringify(signed) }, gas: 50n * TGAS, deposit: ONE_NEAR / 20n }]);
  if (!a.ok) throw new Error(`attach ${i} failed: ${a.error}`);
  (out.attachTxs as string[]).push(a.txHash);
  console.log(`attached leg ${i} (${l.agent}): ${a.txHash}`);
}

// --- a stranger closes it ---
const before = await Promise.all(legs.map((l) => intents.mtBalanceOf(CLOSER, l.tip.token)));
const c = await rpc.sendTx(signerFor(CLOSER), RINGS, [{ type: "FunctionCall", methodName: "close_ring", args: { ring_id: ringId }, gas: 300n * TGAS, deposit: 0n }]);
console.log(`close by ${CLOSER}: ${c.ok ? "ok" : "FAILED " + c.error} ${c.txHash} returned ${c.returnValue}`);
out.closeTx = c.txHash;
out.closeReturn = c.returnValue;
await new Promise((r) => setTimeout(r, 3000));
const ring = await view<{ status: string; closer: string | null; standards: string[] }>("get_ring", { ring_id: ringId });
const after = await Promise.all(legs.map((l) => intents.mtBalanceOf(CLOSER, l.tip.token)));
const tipsReceived = legs.map((l, i) => ({ token: l.tip.token, expected: l.tip.amt, received: (after[i]! - before[i]!).toString() }));
const rep = await Promise.all([...agents, CLOSER].map(async (a) => [a, await view("reputation", { agent: a })]));
out.ring = ring;
out.tipsReceived = tipsReceived;
out.reputation = Object.fromEntries(rep);
console.log("status", ring.status, "closer", ring.closer, "tips", JSON.stringify(tipsReceived));
const pass = ring.status === "Settled" && tipsReceived.every((t) => t.received === t.expected);
out.verdict = pass ? "PASS: a stranger closed a 3-agent ring through the contract; one execute_intents; tips paid to the closer" : "FAIL: see fields";
console.log(out.verdict);
fs.mkdirSync(path.join(ROOT, "docs/measurements"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs/measurements/rings-e2e.json"), JSON.stringify(out, null, 1));
process.exit(pass ? 0 : 1);
