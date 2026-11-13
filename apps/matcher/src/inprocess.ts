// In-process agent link: the matcher talks to AgentRuntime objects directly (sim mode, tests).
import type { AgentRuntime, RingProposal, MultiPayload } from "@nomad/agent";
import type { AgentLink } from "./matcher.js";

export class InProcessLink implements AgentLink {
  constructor(private agents: Map<string, AgentRuntime>, private now: () => number = Date.now) {}
  async propose(agent: string, p: RingProposal): Promise<{ signed?: MultiPayload; reason?: string }> {
    const a = this.agents.get(agent);
    if (!a) return { reason: "unknown agent" };
    const ans = a.onProposal(p, this.now());
    return ans.type === "SIGNED" ? { signed: ans.signed } : { reason: ans.reason };
  }
  settled(agent: string, ringId: string, _tx: string | null, leg: { offerId: string; giveAmt: bigint }) {
    this.agents.get(agent)?.onSettled(ringId, leg.offerId, leg.giveAmt);
  }
  failed(agent: string, ringId: string) {
    this.agents.get(agent)?.onFailed(ringId);
  }
}

/** Routes to in-process agents first, then to agents connected over the bus. */
export class CompositeLink implements AgentLink {
  constructor(private local: Map<string, AgentRuntime>, private inproc: AgentLink, private remote: AgentLink) {}
  private pick(agent: string) {
    return this.local.has(agent) ? this.inproc : this.remote;
  }
  propose(agent: string, p: RingProposal) {
    return this.pick(agent).propose(agent, p);
  }
  settled(agent: string, ringId: string, tx: string | null, leg: { offerId: string; giveAmt: bigint }) {
    this.pick(agent).settled(agent, ringId, tx, leg);
  }
  failed(agent: string, ringId: string, error: string) {
    this.pick(agent).failed(agent, ringId, error);
  }
}
