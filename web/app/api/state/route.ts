import { connection } from "next/server";
import { buildMockState } from "@/lib/mock";
import recorded from "@/lib/live-snapshot.json";
import type { NomadState } from "@/lib/types";

// Server-side proxy to the matcher API (apps/matcher, GET /api/state).
// MATCHER_URL is a server env var, so the browser never talks to the matcher directly.
// Fallback order: live matcher -> recorded real testnet state (lib/live-snapshot.json,
// meta.source "recorded", real tx links) -> nothing else. ?mock=1 serves the UI fixture
// (meta.source "mock") for local UI development.

const recordedState = () => recorded as unknown as NomadState;

export async function GET(req: Request) {
  await connection();
  const url = process.env.MATCHER_URL;
  const forceMock = new URL(req.url).searchParams.get("mock") === "1";
  const headers = { "cache-control": "no-store" };

  if (forceMock) return Response.json(buildMockState(), { headers: { ...headers, "x-nomad-source": "mock" } });

  if (url) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/state`, {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        return Response.json(await res.json(), { headers: { ...headers, "x-nomad-source": "live" } });
      }
      return Response.json(recordedState(), {
        headers: { ...headers, "x-nomad-source": "recorded", "x-nomad-fallback": `matcher HTTP ${res.status}` },
      });
    } catch (e) {
      return Response.json(recordedState(), {
        headers: { ...headers, "x-nomad-source": "recorded", "x-nomad-fallback": `matcher unreachable: ${(e as Error).name}` },
      });
    }
  }
  return Response.json(recordedState(), { headers: { ...headers, "x-nomad-source": "recorded" } });
}
