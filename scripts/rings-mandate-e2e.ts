// Nomad on-chain rings: a ring whose leg is signed by an on-chain MANDATE (Chain Signatures), closed by a stranger
// through rings.nomadswarm.testnet. No hot key signs the mandate's leg: mandate.nomadswarm.testnet checks
// the leg against the owner's rules (tokens, per-leg max, daily budget, min price) and only then asks
// the MPC network to sign it (erc191, for the MPC-derived 0x address).
//   leg 0: mandate 0x account gives USDC, gets USDT (signed via mandate + MPC)
//   leg 1: a05 gives USDT, gets USDC (nep413)
// Usage (from apps/matcher): npx tsx ../../scripts/rings-mandate-e2e.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signerFor, signIntents, ONE_NEAR, TGAS } from "../packages/intents/src/index.js";
import { feeOf } from "../packages/ringfinder/src/index.js";
import { derivedAddress, makeLeg, nextLegId, requestLeg, setMandate, waitSigned } from "./mandate-lib.js";
import { CONFIG, PARENT, client, parent, rpc } from "./k-lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RINGS = `rings.${PARENT}`, CLOSER = `k4.${PARENT}`, A05 = `a05.${PARENT}`;
const tok = (s: string) => CONFIG.tokens.find((t: { symbol: string }) => t.symbol === s)!;
const USDC = tok("USDC").id, USDT = tok("USDT").id;
const out: Record<string, unknown> = { at: new Date().toISOString(), rings: RINGS, closer: CLOSER };

const { address } = await derivedAddress(PARENT);
out.mandateAddress = address;
if ((await client.mtBalanceOf(address, USDC)) < 300_000n) await client.deposit(parent, tok("USDC").contract, 1_000_000n, address);
if ((await client.mtBalanceOf(A05, USDT)) < 300_000n) await client.deposit(parent, tok("USDT").contract, 1_000_000n, A05);

// mandate: USDC up to 200000 per leg, budget = spent today + 300000, min price USDC->USDT 0.99
const spent = BigInt(await rpc.view<string>(`mandate.${PARENT}`, "spent_today", { owner: PARENT, token: USDC }));
await setMandate(parent, {
  eth_address: address,
  tokens: [
    { token: USDC, max_per_leg: "200000", daily_budget: (spent + 300_000n).toString() },
    { token: USDT, max_per_leg: "200000", daily_budget: "1000000" },
  ],
  prices: [{ give: USDC, want: USDT, rate_num: "99", rate_den: "100" }],
  expires_at_ms: Date.now() + 7 * 24 * 3600_000,
});

const fee = BigInt(await client.fee());
const X = 150_000n, Y = 150_000n, TIP = 100n;
const net = (v: bigint) => v - feeOf(v, Number(fee));
const deadline = Date.now() + 10 * 60_000;
const legs = [
  { agent: address, give: USDC, give_amt: X.toString(), get: USDT, get_amt: net(Y).toString(), tip: { token: USDC, amt: TIP.toString() } },
  { agent: A05, give: USDT, give_amt: Y.toString(), get: USDC, get_amt: net(X).toString(), tip: { token: USDT, amt: TIP.toString() } },
];
out.legs = legs;

const proposer = signerFor(`intents-matcher-1.${PARENT}`);
const p = await rpc.sendTx(proposer, RINGS, [{ type: "FunctionCall", methodName: "propose_ring", args: { legs, deadline_ms: deadline }, gas: 50n * TGAS, deposit: ONE_NEAR / 10n }]);
if (!p.ok) throw new Error(`propose failed: ${p.error}`);
const ringId = JSON.parse(p.returnValue!);
out.ringId = ringId;
out.proposeTx = p.txHash;
console.log(`ring ${ringId} proposed: ${p.txHash}`);

// leg 0: the mandate checks it and has the MPC network sign it (erc191)
const mleg = await makeLeg({ owner: PARENT, give: USDC, give_amount: X.toString(), get: USDT, get_amount: net(Y).toString(), tip: { token: USDC, amount: TIP.toString(), receiver_id: RINGS } });
const id = await nextLegId();
const req = await requestLeg(proposer, mleg);
const signed = await waitSigned(id);
if (signed?.status !== "Signed" && !signed?.multi_payload) throw new Error(`mandate did not sign: ${JSON.stringify(signed).slice(0, 300)}`);
out.mandateRequestTx = req.txHash;
out.mandateSignMs = req.ms;
console.log(`mandate signed leg ${id} via MPC in ${req.ms} ms: ${req.txHash}`);
const a0 = await rpc.sendTx(proposer, RINGS, [{ type: "FunctionCall", methodName: "attach_leg", args: { ring_id: ringId, index: 0, signed: JSON.stringify(signed.multi_payload) }, gas: 50n * TGAS, deposit: ONE_NEAR / 20n }]);
if (!a0.ok) throw new Error(`attach mandate leg failed: ${a0.error}`);

// leg 1: a05 signs its own leg (nep413)
const key = JSON.parse(fs.readFileSync(path.join(ROOT, "keys", `${A05}.intents.json`), "utf8"));
const l1 = legs[1]!;
const s1 = signIntents({
  signerId: A05, secretKey: key.private_key, verifierId: CONFIG.verifierId, salt: mleg.salt, deadline: new Date(mleg.deadline_ms),
  intents: [{ intent: "token_diff", diff: { [l1.give]: `-${l1.give_amt}`, [l1.get]: l1.get_amt } }, { intent: "transfer", receiver_id: RINGS, tokens: { [l1.tip.token]: l1.tip.amt } }],
} as never);
const a1 = await rpc.sendTx(signerFor(A05), RINGS, [{ type: "FunctionCall", methodName: "attach_leg", args: { ring_id: ringId, index: 1, signed: JSON.stringify(s1) }, gas: 50n * TGAS, deposit: ONE_NEAR / 20n }]);
if (!a1.ok) throw new Error(`attach a05 failed: ${a1.error}`);
out.attachTxs = [a0.txHash, a1.txHash];

const c = await rpc.sendTx(signerFor(CLOSER), RINGS, [{ type: "FunctionCall", methodName: "close_ring", args: { ring_id: ringId }, gas: 300n * TGAS, deposit: 0n }]);
console.log(`closed by ${CLOSER}: ${c.ok ? "ok" : "FAILED " + c.error} ${c.txHash} -> ${c.returnValue}`);
out.closeTx = c.txHash;
await new Promise((r) => setTimeout(r, 3000));
const ring = await rpc.view<{ status: string; standards: string[] }>(RINGS, "get_ring", { ring_id: ringId });
out.ring = ring;
const pass = ring.status === "Settled";
out.verdict = pass
  ? "PASS: a ring with a mandate-checked, MPC-signed (erc191) leg and a nep413 leg settled through the rings contract, closed by a stranger"
  : "FAIL: see fields";
console.log("ring", ring.status, ring.standards.join(","), "\n" + out.verdict);
fs.mkdirSync(path.join(ROOT, "docs/measurements"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs/measurements/rings-mandate-e2e.json"), JSON.stringify(out, null, 1));
process.exit(pass ? 0 : 1);
