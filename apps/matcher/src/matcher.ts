// The matcher loop (TECH_DOC §9): offers -> rings -> propose -> collect -> own leg -> simulate -> execute.

import { findRings, type Ring as FoundRing } from "@nomad/ringfinder";
import type { Offer, RingProposal, MultiPayload, TokenId } from "@nomad/agent";
import type { Chain, DiffSigner } from "./chain.js";
import type { Ring as UiRing } from "./types.js";

export interface AgentLink {
  /** Sends PROPOSE and resolves with the agent's answer (or a timeout decline). */
  propose(agent: string, p: RingProposal): Promise<{ signed?: MultiPayload; reason?: string }>;
  settled(agent: string, ringId: string, txHash: string | null, leg: { offerId: string; giveAmt: bigint }): void;
  failed(agent: string, ringId: string, error: string): void;
}

export interface MatcherOpts {
  account: string;
  shard: number | null;
  maxLen?: number;
  phi?: number;
  proposalTtlMs?: number; // 60 s
  legDeadlineMs?: number; // <= 120 s
  priceUsd?: Record<TokenId, number>;
  decimals?: Record<TokenId, number>;
  minLegUsd?: number;
  maxRingsPerRound?: number;
  now?: () => number;
  /** Optional per-ring baseline (1Click dry quotes), filled in after settlement. */
  baseline?: (ring: FoundRing) => Promise<{ savingsBps: number; savingsUsd: number; quotedAtMs: number } | null>;
  onRing?: (r: UiRing) => void;
  log?: (msg: string, extra?: object) => void;
}

export class Matcher {
  rings: UiRing[] = [];
  private seq = 0;
  constructor(
    public opts: MatcherOpts,
    readonly chain: Chain,
    private sign: DiffSigner,
    private agents: AgentLink,
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** One matching round over the given live offers. Returns the rings attempted. */
  async round(offers: Offer[]): Promise<UiRing[]> {
    const fee = await this.chain.feePips();
    const found = findRings(offers, {
      feePips: fee,
      maxLen: this.opts.maxLen ?? 5,
      phi: this.opts.phi ?? 0.2,
      priceUsd: this.opts.priceUsd,
      decimals: this.opts.decimals,
      minLegUsd: this.opts.minLegUsd,
      nowMs: this.now(),
      salt: `${this.opts.account}:${this.seq++}`,
      maxRings: this.opts.maxRingsPerRound ?? 20,
    });
    const out: UiRing[] = [];
    // Settle sequentially: rings found in one round are disjoint in capacity, but agents'
    // balances may overlap; the Verifier makes any loser fail atomically.
    for (const r of found) out.push(await this.settle(r));
    return out;
  }

  async settle(r: FoundRing): Promise<UiRing> {
    const now = this.now();
    const salt = await this.chain.salt();
    const deadline = new Date(now + (this.opts.legDeadlineMs ?? 90_000));
    const proposal: RingProposal = {
      ringId: r.ringId,
      legs: r.legs,
      matcherLeg: r.matcherLeg,
      deadline: deadline.toISOString(),
      proposalExpiresAtMs: now + (this.opts.proposalTtlMs ?? 60_000),
      matcher: this.opts.account,
      verifierId: this.chain.verifierId,
      salt,
    };
    const ui: UiRing = {
      ringId: r.ringId,
      k: r.k,
      legs: r.legs.map((l) => ({ ...l, giveAmt: l.giveAmt.toString(), getAmt: l.getAmt.toString() })),
      matcher: this.opts.account,
      matcherLeg: { token: r.matcherLeg.token, amt: r.matcherLeg.amt.toString() },
      signedBy: [],
      surplusBps: Math.round((r.surplusFactor - 1) * 1e4 * 100) / 100,
      matcherShareBps: Math.round((Math.pow(r.surplusFactor, this.opts.phi ?? 0.2) - 1) * 1e4 * 100) / 100,
      savingsBps: null,
      savingsUsd: null,
      baselineQuotedAtMs: null,
      deadline: proposal.deadline,
      proposedAtMs: now,
      settledAtMs: null,
      txHash: null,
      blockHeight: null,
      blocksToExec: null,
      gasBurntTgas: null,
      status: "proposed",
      error: null,
    };
    this.push(ui);
    this.log("propose", { ringId: r.ringId.slice(0, 12), k: r.k, surplusBps: ui.surplusBps });

    // collect signatures in parallel
    const answers = await Promise.all(
      r.legs.map(async (l) => {
        const a = await this.agents.propose(l.agent, proposal).catch((e) => ({ reason: String(e) }) as { signed?: MultiPayload; reason?: string });
        if (a.signed) {
          ui.signedBy.push(l.agent);
          this.emit(ui);
        }
        return { agent: l.agent, ...a };
      }),
    );
    const declined = answers.filter((a) => !a.signed);
    if (declined.length > 0) return this.fail(ui, r, `declined: ${declined.map((d) => `${d.agent} (${d.reason})`).join(", ")}`);
    if (this.now() > proposal.proposalExpiresAtMs) return this.fail(ui, r, "proposal expired");
    ui.status = "signed";
    this.emit(ui);

    const signed = answers.map((a) => a.signed!) as MultiPayload[];
    if (r.matcherLeg.amt > 0n)
      signed.push(
        this.sign({
          diff: { [r.matcherLeg.token]: r.matcherLeg.amt.toString() },
          deadline,
          salt,
          verifierId: this.chain.verifierId,
          memo: `nomad:${r.ringId.slice(0, 16)}:matcher`,
        }),
      );

    const sim = await this.chain.simulate(signed);
    if (!sim.ok) return this.fail(ui, r, `simulate: ${sim.error ?? "failed"}`);
    ui.status = "simulated";
    this.emit(ui);

    ui.status = "submitted";
    this.emit(ui);
    const ex = await this.chain.execute(signed, this.opts.account);
    ui.txHash = ex.txHash;
    ui.blockHeight = ex.blockHeight;
    ui.blocksToExec = ex.blocksToExec;
    ui.gasBurntTgas = ex.gasBurntTgas;
    if (!ex.ok) return this.fail(ui, r, `execute: ${ex.error ?? "failed"}`);
    ui.status = "settled";
    ui.settledAtMs = this.now();
    this.emit(ui);
    this.log("settled", { ringId: r.ringId.slice(0, 12), tx: ex.txHash, blocksToExec: ex.blocksToExec });
    for (const l of r.legs) this.agents.settled(l.agent, r.ringId, ex.txHash, { offerId: l.offerId, giveAmt: l.giveAmt });

    if (this.opts.baseline) {
      const b = await this.opts.baseline(r).catch(() => null);
      if (b) {
        ui.savingsBps = b.savingsBps;
        ui.savingsUsd = b.savingsUsd;
        ui.baselineQuotedAtMs = b.quotedAtMs;
        this.emit(ui);
      }
    }
    return ui;
  }

  private fail(ui: UiRing, r: FoundRing, error: string): UiRing {
    ui.status = "failed";
    ui.error = error;
    this.emit(ui);
    this.log("failed", { ringId: r.ringId.slice(0, 12), error });
    for (const l of r.legs) this.agents.failed(l.agent, r.ringId, error);
    return ui;
  }

  private push(ui: UiRing) {
    this.rings.unshift(ui);
    if (this.rings.length > 500) this.rings.length = 500;
    this.emit(ui);
  }
  private emit(ui: UiRing) {
    this.opts.onRing?.(ui);
  }
  private log(msg: string, extra?: object) {
    this.opts.log?.(msg, extra);
  }
}
