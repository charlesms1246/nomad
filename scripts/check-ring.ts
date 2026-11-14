// Read-only on-chain check of one settled v2 ring (no keys, no transactions).
//   1. read the ring from rings.nomadswarm.testnet (status, closer, legs, wallet standards)
//   2. fetch the close tx from an archival RPC and check it is close_ring(ring_id) from a non-party
//   3. check the Verifier's execute_intents receipt succeeded with one token_diff per leg, each equal to
//      the leg's spec (-give_amt of give, +get_amt of get) for the leg's signer
//   4. check the ring_settled event and that each tip was mt_transferred to the closer
//   5. check the Verifier's code hash equals mainnet intents.near's
// Usage (from apps/matcher): npx tsx ../../scripts/check-ring.ts [ring_id close_tx closer]
import { NearRpc, MAINNET_RPC } from "../packages/intents/src/index.js";

const RINGS = "rings.nomadswarm.testnet";
const VERIFIER = "intents.nomadswarm.testnet";
const [RING_ID, CLOSE_TX, CLOSER] = process.argv.length > 4
  ? process.argv.slice(2, 5)
  : ["f5d3e16fca764b6f752ab5d3254b67fd", "GALT4S7BiENHVroypTv1uQmanBAmhm9uSXbyHpShD7hR", "k4.nomadswarm.testnet"];

// Archival endpoints keep old transactions; regular RPC nodes drop them after a few epochs.
const rpc = new NearRpc("https://archival-rpc.testnet.fastnear.com", ["https://archival-rpc.testnet.near.org"]);
const mainnet = new NearRpc(MAINNET_RPC);

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};
const events = (logs: string[]) =>
  logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));

const ring: any = await rpc.view(RINGS, "get_ring", { ring_id: RING_ID }, "final");
check(!!ring, `ring ${RING_ID} exists on ${RINGS}`);
if (!ring) process.exit(1);
const agents: string[] = ring.legs.map((l: any) => l.agent);
check(ring.status === "Settled", `status ${ring.status}, closer ${ring.closer}`);
console.log(`      legs: ${ring.legs.map((l: any, i: number) => `${l.agent.slice(0, 18)} [${ring.standards[i]}] -${l.give_amt} ${l.give.split(":")[1].split(".")[0]} +${l.get_amt} ${l.get.split(":")[1].split(".")[0]}`).join(" | ")}`);
check(ring.closer === CLOSER && !agents.includes(CLOSER), `closed by ${CLOSER}, which is not one of the ring's ${agents.length} parties`);

const tx: any = await rpc.call("tx", { tx_hash: CLOSE_TX, sender_account_id: CLOSER, wait_until: "EXECUTED_OPTIMISTIC" });
const fc = tx.transaction.actions[0]?.FunctionCall;
const args = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()) : {};
check(
  tx.transaction.signer_id === CLOSER && tx.transaction.receiver_id === RINGS && fc?.method_name === "close_ring" && args.ring_id === RING_ID,
  `tx ${CLOSE_TX.slice(0, 8)}… is ${CLOSER} -> ${RINGS}.close_ring({ring_id: ${RING_ID.slice(0, 8)}…})`,
);
check("SuccessValue" in (tx.status ?? {}), `close_ring returned ${JSON.stringify(tx.status)}`);

const verifierReceipt = tx.receipts_outcome.find(
  (o: any) => o.outcome.executor_id === VERIFIER && events(o.outcome.logs).some((e) => e.event === "token_diff"),
);
check(!!verifierReceipt && "SuccessValue" in verifierReceipt.outcome.status, `${VERIFIER} executed execute_intents successfully`);
const diffs = events(verifierReceipt?.outcome.logs ?? []).filter((e) => e.event === "token_diff").flatMap((e) => e.data);
check(diffs.length === ring.legs.length, `${diffs.length} token_diff events for ${ring.legs.length} legs`);
ring.legs.forEach((l: any, i: number) => {
  const d = diffs.find((x: any) => x.account_id === l.agent);
  const ok = !!d && d.diff[l.give] === `-${l.give_amt}` && d.diff[l.get] === `${l.get_amt}` && Object.keys(d.diff).length === 2;
  check(ok, `leg ${i} (${ring.standards[i]}): executed diff equals the signed spec -${l.give_amt}/+${l.get_amt}`);
});

const all = tx.receipts_outcome.flatMap((o: any) => events(o.outcome.logs));
check(all.some((e: any) => e.event === "ring_settled" && e.data[0]?.ring_id === RING_ID), "rings contract emitted ring_settled");
const tipsPaid = all.filter((e: any) => e.event === "mt_transfer").flatMap((e: any) => e.data)
  .filter((t: any) => t.old_owner_id === RINGS && t.new_owner_id === CLOSER);
ring.legs.filter((l: any) => l.tip).forEach((l: any) => {
  const ok = tipsPaid.some((t: any) => t.token_ids[0] === l.tip.token && t.amounts[0] === l.tip.amt);
  check(ok, `tip ${l.tip.amt} ${l.tip.token.split(":")[1].split(".")[0]} paid to the closer`);
});

const [tn, mn] = await Promise.all([rpc.viewAccount(VERIFIER), mainnet.viewAccount("intents.near")]);
check(!!tn && tn.code_hash === mn?.code_hash, `${VERIFIER} code hash ${tn?.code_hash} = mainnet intents.near`);

console.log(failed ? `${failed} check(s) FAILED` : "PASS: ring settled atomically on testnet, closed by a non-party, every leg executed exactly as signed");
process.exit(failed ? 1 : 0);
