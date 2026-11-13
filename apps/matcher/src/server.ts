// Matcher HTTP + WebSocket server.
//   GET  /api/state   NomadState for the UI (CORS open, read-only)
//   GET  /healthz
//   WS   /ws          agent bus (TECH_DOC §6.2): HELLO/OFFERS in, PROPOSE out, SIGNED/DECLINE in, SETTLED/FAILED out
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  fromWireOffer,
  toWireProposal,
  type BusMessage,
  type Offer,
  type RingProposal,
  type MultiPayload,
} from "@nomad/agent";
import type { AgentLink } from "./matcher.js";
import type { NomadState } from "./types.js";
import { jsonBig } from "./state.js";

/** Agents connected over the bus. Offers they announce feed the matcher; proposals go back over the socket. */
export class WsLink implements AgentLink {
  sockets = new Map<string, WebSocket>();
  offers = new Map<string, Offer[]>();
  private waiting = new Map<string, (a: { signed?: MultiPayload; reason?: string }) => void>();

  constructor(private timeoutMs = 60_000) {}

  attach(ws: WebSocket) {
    let agent: string | null = null;
    ws.on("message", (raw) => {
      let m: BusMessage;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type === "HELLO" || m.type === "OFFERS") {
        agent = m.agent;
        this.sockets.set(m.agent, ws);
        this.offers.set(m.agent, m.offers.map(fromWireOffer).filter((o) => o.agent === m.agent));
      } else if (m.type === "SIGNED" || m.type === "DECLINE") {
        if (agent !== m.agent) return; // an agent can only answer for itself
        const k = `${m.ringId}|${m.agent}`;
        const w = this.waiting.get(k);
        if (!w) return;
        this.waiting.delete(k);
        w(m.type === "SIGNED" ? { signed: m.signed } : { reason: m.reason });
      }
    });
    ws.on("close", () => {
      if (agent && this.sockets.get(agent) === ws) {
        this.sockets.delete(agent);
        this.offers.delete(agent);
      }
    });
  }

  allOffers(): Offer[] {
    return [...this.offers.values()].flat();
  }

  propose(agent: string, p: RingProposal): Promise<{ signed?: MultiPayload; reason?: string }> {
    const ws = this.sockets.get(agent);
    if (!ws) return Promise.resolve({ reason: "agent offline" });
    return new Promise((resolve) => {
      const k = `${p.ringId}|${agent}`;
      const t = setTimeout(() => {
        this.waiting.delete(k);
        resolve({ reason: "timeout" });
      }, Math.min(this.timeoutMs, Math.max(0, p.proposalExpiresAtMs - Date.now())));
      this.waiting.set(k, (a) => {
        clearTimeout(t);
        resolve(a);
      });
      ws.send(jsonBig({ type: "PROPOSE", to: agent, proposal: toWireProposal(p) } satisfies BusMessage));
    });
  }

  settled(agent: string, ringId: string, txHash: string | null) {
    this.sockets.get(agent)?.send(jsonBig({ type: "SETTLED", ringId, txHash: txHash ?? "" } satisfies BusMessage));
  }
  failed(agent: string, ringId: string, error: string) {
    this.sockets.get(agent)?.send(jsonBig({ type: "FAILED", ringId, error } satisfies BusMessage));
  }
}

export function startServer(opts: { port: number; state: () => NomadState; link?: WsLink; log?: (m: string) => void }) {
  const server = http.createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
      return res.end(jsonBig(opts.state()));
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, cors);
      return res.end("ok");
    }
    res.writeHead(404, cors);
    res.end("not found");
  });
  if (opts.link) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => opts.link!.attach(ws));
  }
  server.listen(opts.port, () => opts.log?.(`matcher API on http://localhost:${opts.port}/api/state`));
  return server;
}
