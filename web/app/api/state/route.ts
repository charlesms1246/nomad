import { connection } from "next/server";
import { buildMockState } from "@/lib/mock";

// Server-side proxy to the matcher API (apps/matcher, GET /api/state).
// MATCHER_URL is a server env var, so the browser never talks to the matcher
// directly (no CORS or mixed-content issues on Vercel).
// With no MATCHER_URL, with ?mock=1, or when the matcher is unreachable, it
// serves the UI fixture with meta.source = "mock", which the UI labels.

export async function GET(req: Request) {
  await connection();
  const url = process.env.MATCHER_URL;
  const forceMock = new URL(req.url).searchParams.get("mock") === "1";
  const headers = { "cache-control": "no-store" };

  if (url && !forceMock) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/state`, {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        return Response.json(await res.json(), { headers: { ...headers, "x-nomad-source": "live" } });
      }
      return Response.json(buildMockState(), {
        headers: { ...headers, "x-nomad-source": "mock", "x-nomad-fallback": `matcher HTTP ${res.status}` },
      });
    } catch (e) {
      return Response.json(buildMockState(), {
        headers: { ...headers, "x-nomad-source": "mock", "x-nomad-fallback": `matcher unreachable: ${(e as Error).name}` },
      });
    }
  }
  return Response.json(buildMockState(), { headers: { ...headers, "x-nomad-source": "mock" } });
}
