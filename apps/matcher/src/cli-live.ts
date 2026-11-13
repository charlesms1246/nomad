#!/usr/bin/env node
// make live / make race: agents + matcher(s) on our testnet Verifier.
//  - agents (in-process here; they can also connect over /ws) post offers to the board with
//    their function-call keys and sign legs with their Verifier keys;
//  - the production matcher (on the Verifier's shard, checked with colo) reads the board,
//    finds rings, collects signed legs, simulates, then submits one execute_intents per ring;
//  - RACE=1 adds the control matcher on another shard: both get the same ring and submit at
//    once; the first to execute wins and the other fails atomically. Blocks-to-execute is logged.
// Env: AGENTS=12 ROUND_MS=6000 PORT=8787 RACE=0 STRICT_COLO=0 MAX_ROUNDS=0 (0 = forever) SEED=1
import fs from "node:fs";
import path from "node:path";
import { AgentRuntime, BoardClient, rngFrom, type Offer, type StrategyName, type TokenInfo } from "@nomad/agent";
import { findRings, type Ring as FoundRing } from "@nomad/ringfinder";
import { NearRpc, signerFor, TESTNET_RPC } from "@nomad/intents";
import { check } from "@nomad/colo";
import { baseline, buildTokenMap, getTokens, type TokenSymbol } from "@nomad/oneclick";
import { Matcher } from "./matcher.js";
import { InProcessLink, CompositeLink } from "./inprocess.js";
import { LiveChain, liveSigner } from "./live-chain.js";
import { WsLink, startServer } from "./server.js";
import { buildState } from "./state.js";
import { loadConfig, agentIds, readKey, repoRoot, AGENT_PLAN } from "./config.js";
import { SIM_TOKENS } from "./sim.js";
import type { Ring as UiRing, RaceStats } from "./types.js";

const env = (k: string, d: string) => process.env[k] ?? d;
// RACE=1: Verifier-shard matcher vs other-shard matcher. RACE=3 adds a third matcher that submits
// as the Verifier through a delegated execute_intents key (`make relayer-key`), like intents.near.
const RACE_N = +env("RACE", "0");
const RACE = RACE_N > 0;
const ROUND_MS = +env("ROUND_MS", "6000");
const MAX_ROUNDS = +env("MAX_ROUNDS", "0");
const SEED = +env("SEED", "1");
const STRATS: StrategyName[] = ["spender"];
const log = (m: string, x?: object) => console.log(new Date().toISOString(), m, x ? JSON.stringify(x) : "");

async function main() {
  const cfg = loadConfig();
  if (cfg.tokens.length === 0) throw new Error("config/testnet.json has no tokens yet (agent1 writes it after deploying them)");
  const rpc = new NearRpc(cfg.rpcUrl ?? TESTNET_RPC);
  const board = new BoardClient(rpc, cfg.boardId!);
  const outDir = path.join(repoRoot(), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const ringLog = path.join(outDir, RACE ? "race-rings.jsonl" : "live-rings.jsonl");

  // prices: live 1Click mid prices (mainnet, read-only), else the 2026-11-13 snapshot
  const tokens: TokenInfo[] = cfg.tokens.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    decimals: t.decimals,
    priceUsd: SIM_TOKENS.find((s) => s.symbol === t.symbol)?.priceUsd ?? 1,
  }));
  try {
    const live = await getTokens();
    for (const t of tokens) {
      const asset = cfg.tokens.find((c) => c.id === t.id)?.mainnetAsset;
      const p = live.find((x) => x.id === asset)?.price;
      if (p) t.priceUsd = p;
    }
    log("prices from 1Click", Object.fromEntries(tokens.map((t) => [t.symbol, t.priceUsd])));
  } catch (e) {
    log("1Click prices unavailable, using snapshot", { error: String(e) });
  }
  const tokenMap = buildTokenMap(
    Object.fromEntries(cfg.tokens.map((t) => [t.symbol, { testnetId: t.id, testnetDecimals: t.decimals }])) as Partial<Record<TokenSymbol, { testnetId: string; testnetDecimals: number }>>,
  );

  // matchers
  const prodId = cfg.matcherId ?? `intents-matcher.${cfg.parent}`;
  const ctrlId = cfg.controlMatcherId ?? `matcher.${cfg.parent}`;
  const colo = await check({ account: prodId, target: cfg.verifierId }, { network: "testnet" });
  log("colo check", colo);
  if (!colo.colocated) {
    log("COLO_MISPLACED: matcher is not on the Verifier's shard; settling one block slower");
    if (env("STRICT_COLO", "0") === "1") process.exit(1);
  }

  // agents
  const rng = rngFrom(SEED);
  const agents = new Map<string, AgentRuntime>();
  const ids = agentIds(+env("AGENTS", "12"), cfg.parent);
  const chainFor = (id: string) => new LiveChain({ rpcUrl: cfg.rpcUrl, verifierId: cfg.verifierId }, signerFor(id));
  const readChain = chainFor(prodId);
  ids.forEach((id, i) => {
    const ik = readKey(id, "intents");
    const strategy = STRATS[i % STRATS.length]!;
    agents.set(
      id,
      new AgentRuntime(
        {
          id,
          strategy,
          target: tokens.find((t) => t.symbol === AGENT_PLAN[i % AGENT_PLAN.length]!.want)?.id ?? tokens[(i * 2 + 1) % tokens.length]!.id,
          margin: 0.002 + rng() * 0.012,
          sizeFrac: 0.4 + rng() * 0.4,
          ttlMs: 10 * 60_000,
          verifierId: cfg.verifierId,
        },
        liveSigner({ signerId: id, secretKey: ik.secretKey }),
        (ts) => readChain.balances(id, ts),
        rngFrom(SEED * 1000 + i),
      ),
    );
  });
  const wsLink = new WsLink();
  const link = new CompositeLink(agents, new InProcessLink(agents), wsLink);

  const rings: UiRing[] = [];
  const race: RaceStats = { rounds: 0, matchers: [] };
  const onRing = (r: UiRing) => {
    if (!rings.includes(r)) rings.unshift(r);
    if (rings.length > 300) rings.length = 300;
    if (r.status === "settled" || r.status === "failed") fs.appendFileSync(ringLog, JSON.stringify({ at: new Date().toISOString(), ...r }) + "\n");
  };
  const mk = (id: string, chain = chainFor(id)) =>
    new Matcher(
      {
        account: id,
        shard: null,
        priceUsd: Object.fromEntries(tokens.map((t) => [t.id, t.priceUsd])),
        decimals: Object.fromEntries(tokens.map((t) => [t.id, t.decimals])),
        minLegUsd: 0.05,
        onRing,
        log,
        baseline: async (ring) => {
          // one 1Click dry quote per leg at the same moment; mean savings across legs
          const bs = await Promise.all(ring.legs.map((l) => baseline({ give: l.give, giveAmt: l.giveAmt, get: l.get, getAmt: l.getAmt }, { tokens: tokenMap })));
          const mean = bs.reduce((s, b) => s + b.savingsBps, 0) / bs.length;
          const usd = ring.legs.reduce((s, l, i) => {
            const t = tokens.find((x) => x.id === l.get)!;
            return s + ((Number(BigInt(bs[i]!.ringAmountOut) - BigInt(bs[i]!.quoteAmountOut)) / 10 ** t.decimals) * t.priceUsd);
          }, 0);
          return { savingsBps: Math.round(mean * 10) / 10, savingsUsd: Math.round(usd * 10_000) / 10_000, quotedAtMs: Date.parse(bs[0]!.timestamp) };
        },
      },
      chain,
      liveSigner({ signerId: id, secretKey: readKey(id, "intents").secretKey }),
      link,
    );
  // Delegated mode: the tx signer is the Verifier itself (a local receipt), through a key limited to execute_intents.
  const relayerChain = () => {
    const k = readKey(cfg.verifierId, "relayer");
    return new LiveChain({ rpcUrl: cfg.rpcUrl, verifierId: cfg.verifierId }, { signerId: cfg.verifierId, secretKey: k.secretKey });
  };
  const relayerMatcherId = cfg.relayerMatcherId ?? `intents-matcher-1.${cfg.parent}`;
  const SUBMIT_AS_VERIFIER = env("SUBMIT_AS", "") === "verifier";
  const prod = mk(prodId, SUBMIT_AS_VERIFIER ? relayerChain() : chainFor(prodId));
  const racers: { m: Matcher; label: string; txSigner: string }[] = [{ m: prod, label: prodId, txSigner: SUBMIT_AS_VERIFIER ? cfg.verifierId : prodId }];
  if (RACE) racers.push({ m: mk(ctrlId), label: ctrlId, txSigner: ctrlId });
  if (RACE_N >= 3) racers.push({ m: mk(relayerMatcherId, relayerChain()), label: `${relayerMatcherId} (signs as ${cfg.verifierId})`, txSigner: cfg.verifierId });
  for (const { m, label, txSigner } of racers) {
    const c = await check({ account: txSigner, target: cfg.verifierId }, { network: "testnet" });
    m.opts.shard = c.accountShard;
    race.matchers.push({ account: label, shard: c.accountShard, colocated: c.colocated, wins: 0, blocksToExecHist: {} });
  }

  startServer({
    port: +env("PORT", "8787"),
    link: wsLink,
    log,
    state: () =>
      buildState({
        meta: {
          network: "testnet",
          verifier: cfg.verifierId,
          verifierShard: colo.targetShard,
          board: cfg.boardId!,
          explorerTxUrl: "https://testnet.nearblocks.io/txns/",
          source: "live",
          tokens,
          baseline: lastBaseline,
        },
        agents: () => agents.values(),
        rings: () => rings,
        swarm: () => {
          const settled = rings.filter((r) => r.status === "settled");
          const hist: Record<string, number> = {};
          for (const r of settled) hist[String(r.k)] = (hist[String(r.k)] ?? 0) + 1;
          return { source: "live", seed: SEED, points: [], ringLengthHist: hist };
        },
        race: () => (RACE ? race : null),
      }),
  });

  let lastBaseline: { pair: string; bps: number; quotedAtMs: number } | null = null;
  const refreshBaseline = async () => {
    const w = tokens.find((t) => t.symbol === "wNEAR"), u = tokens.find((t) => t.symbol === "USDC");
    if (!w || !u) return;
    try {
      const one = 10n ** BigInt(w.decimals);
      const b = await baseline({ give: w.id, giveAmt: one, get: u.id, getAmt: BigInt(Math.round(w.priceUsd * 10 ** u.decimals)) }, { tokens: tokenMap });
      lastBaseline = { pair: "wNEAR->USDC", bps: -Math.round(b.savingsBps * 10) / 10, quotedAtMs: Date.parse(b.timestamp) };
      log("1Click baseline vs mid", lastBaseline);
    } catch (e) {
      log("baseline failed", { error: String(e) });
    }
  };
  await refreshBaseline();
  setInterval(refreshBaseline, 10 * 60_000).unref();

  const posted = new Map<string, string>(); // local offer id -> board id
  const postedMax = new Map<string, bigint>(); // board id -> giveMax on the board
  for (let round = 1; MAX_ROUNDS === 0 || round <= MAX_ROUNDS; round++) {
    const t0 = Date.now();
    // 1. agents refresh and post new offers to the board (function-call key, no deposit)
    for (const a of agents.values()) {
      try {
        const offers = await a.refresh(tokens, Date.now());
        for (const o of offers) {
          const known = posted.has(o.id) || postedMax.has(o.id);
          // re-post (replaces the board offer for this pair) when a settled ring shrank it
          if (known && (postedMax.get(o.id) ?? o.giveMax) <= o.giveMax) continue;
          const bk = readKey(a.id, "board");
          const boardId = await board.postOffer({ signerId: a.id, secretKey: bk.secretKey }, o, a.cfg.ttlMs ?? 600_000);
          posted.set(o.id, boardId);
          postedMax.set(boardId, o.giveMax);
          o.id = boardId; // the agent and the board now agree on the id
          log("offer", { agent: a.id, id: boardId, give: sym(tokens, o.give), want: sym(tokens, o.want), giveMax: o.giveMax.toString() });
        }
      } catch (e) {
        log("agent refresh/post failed", { agent: a.id, error: String(e).slice(0, 300) });
      }
    }
    // 2. matcher reads the public board (plus any bus agents' offers)
    let book: Offer[] = [];
    try {
      // In-process agents' own offer state is authoritative (it shrinks as rings settle);
      // other agents' offers come from the public board and the bus.
      const local = new Map([...agents.values()].flatMap((a) => a.offers.map((o) => [o.id, o] as const)));
      const fromBoard = (await board.offers()).filter((o) => !agents.has(o.agent) || local.has(o.id)).map((o) => local.get(o.id) ?? o);
      book = [...fromBoard, ...wsLink.allOffers()];
    } catch (e) {
      log("board read failed", { error: String(e).slice(0, 200) });
    }
    // 3. match and settle
    if (!RACE) {
      const res = await prod.round(book);
      for (const r of res) if (r.status === "settled" && r.txHash) recordRing(r);
    } else {
      const fee = await prod.chain.feePips();
      const found = findRings(book, {
        feePips: fee,
        priceUsd: prod.opts.priceUsd,
        decimals: prod.opts.decimals,
        minLegUsd: 0.05,
        salt: `race:${round}`,
      });
      for (const x of racers) x.m.noteOffers(book);
      for (const r of found) {
        race.rounds++;
        // every matcher gets the same ring at the same moment; agents sign each with the same per-offer nonce,
        // so exactly one batch can execute and the rest fail with "nonce was already used"
        const res = await Promise.all(racers.map((x, i) => x.m.settle(i === 0 ? r : ({ ...r, ringId: r.ringId.slice(0, 62) + "r" + i } as FoundRing))));
        res.forEach((x, i) => {
          const m = race.matchers[i]!;
          if (x.status === "settled") {
            m.wins++;
            if (x.txHash) recordRing(x);
          }
          // blocks-to-execute counts every submitted batch, winner or not (both execute; the loser's panics)
          if (x.blocksToExec !== null) m.blocksToExecHist[String(x.blocksToExec)] = (m.blocksToExecHist[String(x.blocksToExec)] ?? 0) + 1;
        });
        log("race", { ring: r.ringId.slice(0, 12), ...Object.fromEntries(res.map((x, i) => [racers[i]!.label.split(".")[0], [x.status, x.blocksToExec]])) });
      }
    }
    for (const a of agents.values()) {
      a.unmatchedRounds++;
      // An agent whose wants are met (no live offers) picks a new spending need, so the economy keeps moving.
      if (a.offers.length === 0) {
        const others = tokens.filter((t) => t.id !== a.cfg.target);
        a.cfg.target = others[Math.floor(rng() * others.length)]!.id;
      }
    }
    const wait = ROUND_MS - (Date.now() - t0);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
  log("done");
  process.exit(0);

  function recordRing(r: UiRing) {
    const m = r.matcher;
    board
      .recordRing(signerFor(m), r.ringId, r.legs.map((l) => l.offerId ?? "0"), r.txHash!)
      .then((x) => !x.ok && log("record_ring failed", { error: x.error }))
      .catch((e) => log("record_ring failed", { error: String(e).slice(0, 200) }));
  }
}

const sym = (tokens: TokenInfo[], id: string) => tokens.find((t) => t.id === id)?.symbol ?? id;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
