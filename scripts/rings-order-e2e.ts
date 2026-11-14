// Nomad v2, ERC-7683 path end to end on testnet:
//   an Ethereum wallet (fresh secp256k1 key) signs an ERC-7683 (earlier draft) GaslessCrossChainOrder
//   (EIP-712): "give up to 1 USDC, want at least 0.285 wNEAR per USDC" -> anyone relays it to
//   rings.nomadswarm.testnet `submit_order` (EIP-712 digest + ecrecover ON CHAIN) ->
//   a ring that pays the wallet below its price is REJECTED by the contract ->
//   a ring at its price is proposed; the wallet signs its leg (erc191), two NEAR agents sign theirs
//   (nep413); a stranger closes it -> one execute_intents; the order's `filled` advances.
// Usage (from apps/matcher): npx tsx ../../scripts/rings-order-e2e.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  NearRpc, IntentsClient, signerFor, signIntents, TESTNET_RPC, TESTNET_RPC_FALLBACKS, ONE_NEAR, TGAS,
  ethAddressOf, signErc191Intents, buildLegOrder, signOrder, nomadDomain, buildNonce,
} from "../packages/intents/src/index.js";
import { sizeRing, feeOf, type Offer } from "../packages/ringfinder/src/index.js";
import { limitRate } from "../apps/agent/src/strategies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/testnet.json"), "utf8"));
const RINGS = "rings.nomadswarm.testnet", PARENT = "nomadswarm.testnet", CLOSER = "k4.nomadswarm.testnet";
const rpc = new NearRpc(TESTNET_RPC, TESTNET_RPC_FALLBACKS);
const intents = new IntentsClient({ rpc, verifierId: cfg.verifierId });
const tok = (s: string) => cfg.tokens.find((t: { symbol: string }) => t.symbol === s);
const U = tok("USDC"), W = tok("wNEAR"), Z = tok("ZEC");
const out: Record<string, unknown> = { at: new Date().toISOString(), rings: RINGS, standard: "ERC-7683 (earlier draft) GaslessCrossChainOrder, EIP-712, chainId 398" };

// 1. a fresh Ethereum wallet (key kept out of git)
const pk = new Uint8Array(randomBytes(32)); // a valid secp256k1 key with overwhelming probability
const user = ethAddressOf(pk);
fs.mkdirSync(path.join(ROOT, "keys"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "keys", `erc7683-${Date.now()}.json`), JSON.stringify({ address: user, privateKey: Buffer.from(pk).toString("hex") }), { mode: 0o600 });
out.user = user;
console.log("wallet", user);

// 2. its signed order: give up to 1 USDC, want >= 0.285 wNEAR per USDC
const now = Math.floor(Date.now() / 1000);
const domain = nomadDomain("testnet");
const legNonce = buildNonce(await intents.currentSalt(), new Date((now + 900) * 1000));
const order = buildLegOrder({
  leg: { give: U.id, giveAmount: 1_000_000n, want: W.id, minWantAmount: 285_000_000_000_000_000_000_000n },
  nonce: legNonce, user, openDeadline: now + 900, fillDeadline: now + 900, domain,
});
const sig = signOrder(order, domain, pk);
const orderArg = {
  user, nonce: order.nonce.toString(), open_deadline: order.openDeadline, fill_deadline: order.fillDeadline,
  give: U.id, give_amount: "1000000", want: W.id, min_want_amount: "285000000000000000000000",
};
const relayer = signerFor(`intents-matcher-1.${PARENT}`);
const so = await rpc.sendTx(relayer, RINGS, [{ type: "FunctionCall", methodName: "submit_order", args: { order: orderArg, signature: sig.rsv }, gas: 50n * TGAS, deposit: ONE_NEAR / 10n }]);
if (!so.ok) throw new Error(`submit_order failed: ${so.error}`);
const orderId = JSON.parse(so.returnValue!);
console.log(`order ${orderId} accepted on chain (ecrecover = ${user}): ${so.txHash}`);
out.submitOrderTx = so.txHash;
out.orderId = orderId;

// 3. fund the wallet inside the Verifier (testnet USDC, incl. the tip)
const dep = await intents.deposit(signerFor(PARENT), U.contract, 1_100_000n, user);
out.fundTx = dep.txHash;

// ring: wallet USDC -> wNEAR, a03 wNEAR -> ZEC, a01 ZEC -> USDC
const px: Record<string, number> = { USDC: 1, wNEAR: 3.45, ZEC: 939 };
const T = [U, W, Z].map((t) => ({ ...t, priceUsd: px[t.symbol]! }));
const who = [user, `a03.${PARENT}`, `a01.${PARENT}`];
const fee = await intents.fee();
const deadline = (now + 600) * 1000;
const offersAt = (userRate: number) =>
  T.map((t, i): Offer => {
    const next = T[(i + 1) % 3]!;
    const r = i === 0 ? limitRate({ ...t, priceUsd: userRate }, { ...next, priceUsd: 1 }, 0) : limitRate(t, next, 0.01);
    const usd = i === 0 ? 0.9 : 0.4;
    const giveMax = BigInt(Math.floor((usd / t.priceUsd) * 10 ** Math.min(t.decimals, 15))) * 10n ** BigInt(Math.max(0, t.decimals - 15));
    return { id: `o${i}`, agent: who[i]!, give: t.id, giveMax, want: next.id, rateNum: r.rateNum, rateDen: r.rateDen, expiresAtMs: deadline };
  });
const legsFor = (userRate: number) => {
  const s = sizeRing(offersAt(userRate), { feePips: fee, phi: 0, minGiveUnits: 1n });
  if (!s) throw new Error("ring does not clear");
  const raw = s.legs.map((l, i) => ({ ...l, getAmt: i === s.legs.length - 1 ? l.getAmt + s.matcherLeg.amt : l.getAmt }));
  raw.forEach((l, i) => {
    const ng = raw[(i + 1) % raw.length]!.giveAmt;
    if (l.getAmt !== ng - feeOf(ng, fee)) throw new Error("does not close");
  });
  return raw.map((l) => ({ agent: l.agent, give: l.give, give_amt: l.giveAmt.toString(), get: l.get, get_amt: l.getAmt.toString(), tip: { token: l.give, amt: (l.giveAmt / 1000n || 1n).toString() } }));
};

// 4. a ring that pays the wallet only 0.25 wNEAR per USDC must be rejected by the contract
const low = legsFor(0.25);
const bad = await rpc.sendTx(relayer, RINGS, [{ type: "FunctionCall", methodName: "propose_ring", args: { legs: low, deadline_ms: deadline }, gas: 50n * TGAS, deposit: ONE_NEAR / 10n }]).catch((e) => ({ ok: false, error: String(e), txHash: "" }));
console.log(`ring below the order's price: ${bad.ok ? "ACCEPTED (unexpected)" : "rejected: " + String(bad.error).match(/pays less than order[^"\\]*/)?.[0]}`);
out.belowPrice = { ok: bad.ok, error: String(bad.error ?? "").slice(0, 200), txHash: bad.txHash };

// 5. a ring at the order's price
const legs = legsFor(0.2875);
const p = await rpc.sendTx(relayer, RINGS, [{ type: "FunctionCall", methodName: "propose_ring", args: { legs, deadline_ms: deadline }, gas: 50n * TGAS, deposit: ONE_NEAR / 10n }]);
if (!p.ok) throw new Error(`propose failed: ${p.error}`);
const ringId = JSON.parse(p.returnValue!);
console.log(`ring ${ringId} proposed: ${p.txHash}`);
out.legs = legs;
out.ringId = ringId;
out.proposeTx = p.txHash;
const salt = await intents.currentSalt();
const ix = (l: (typeof legs)[number]) => [
  { intent: "token_diff", diff: { [l.give]: `-${l.give_amt}`, [l.get]: l.get_amt } },
  { intent: "transfer", receiver_id: RINGS, tokens: { [l.tip.token]: l.tip.amt } },
];
out.attachTxs = [];
for (const [i, l] of legs.entries()) {
  let signed: unknown;
  let by = relayer;
  if (l.agent === user) {
    signed = signErc191Intents({ privateKey: pk, verifierId: cfg.verifierId, salt, deadline: new Date(deadline), intents: ix(l) as never, nonce: legNonce } as never);
  } else {
    const key = JSON.parse(fs.readFileSync(path.join(ROOT, "keys", `${l.agent}.intents.json`), "utf8"));
    signed = signIntents({ signerId: l.agent, secretKey: key.private_key, verifierId: cfg.verifierId, salt, deadline: new Date(deadline), intents: ix(l) } as never);
    by = signerFor(l.agent);
  }
  const a = await rpc.sendTx(by, RINGS, [{ type: "FunctionCall", methodName: "attach_leg", args: { ring_id: ringId, index: i, signed: JSON.stringify(signed) }, gas: 50n * TGAS, deposit: ONE_NEAR / 20n }]);
  if (!a.ok) throw new Error(`attach ${i} failed: ${a.error}`);
  (out.attachTxs as string[]).push(a.txHash);
  console.log(`attached leg ${i} (${l.agent.startsWith("0x") ? "erc191 " : "nep413 "}${l.agent}): ${a.txHash}`);
}
const c = await rpc.sendTx(signerFor(CLOSER), RINGS, [{ type: "FunctionCall", methodName: "close_ring", args: { ring_id: ringId }, gas: 300n * TGAS, deposit: 0n }]);
console.log(`closed by ${CLOSER}: ${c.ok ? "ok" : "FAILED " + c.error} ${c.txHash} -> ${c.returnValue}`);
out.closeTx = c.txHash;
await new Promise((r) => setTimeout(r, 3000));
const ring = await rpc.view<{ status: string; standards: string[] }>(RINGS, "get_ring", { ring_id: ringId });
const ord = await rpc.view<{ filled: string }>(RINGS, "get_order", { order_id: orderId });
console.log("ring", ring.status, "standards", ring.standards.join(","), "order filled", ord.filled, "of 1000000");
out.ring = ring;
out.orderAfter = ord;
const pass = !bad.ok && ring.status === "Settled" && BigInt(ord.filled) > 0n;
out.verdict = pass
  ? "PASS: an EIP-712 ERC-7683 order was verified on chain (ecrecover), a ring below its price was rejected, a ring at its price settled with the wallet's erc191 leg, and the order was filled"
  : "FAIL: see fields";
console.log(out.verdict);
fs.writeFileSync(path.join(ROOT, "docs/measurements/rings-order-e2e.json"), JSON.stringify(out, null, 1));
process.exit(pass ? 0 : 1);
