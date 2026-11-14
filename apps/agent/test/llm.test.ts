import { describe, it, expect, vi, afterEach } from "vitest";
import { llmMarginAdvisor } from "../src/llm.js";
import { AgentRuntime, rngFrom, type TokenInfo } from "../src/index.js";

const tokens: TokenInfo[] = [
  { id: "W", symbol: "wNEAR", decimals: 24, priceUsd: 3.5 },
  { id: "U", symbol: "USDC", decimals: 6, priceUsd: 1 },
];
const reply = (content: string, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("LLM margin advisor (NEAR AI Cloud, OpenAI-compatible)", () => {
  it("sends the plan and holdings, and parses the margin", async () => {
    const f = reply('{"margin": 0.012}');
    vi.stubGlobal("fetch", f);
    const m = await llmMarginAdvisor({ apiKey: "k", plan: "need USDC soon" })({ holdings: { W: 10n ** 24n }, tokens });
    expect(m).toBe(0.012);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(String(init.body)).toContain("need USDC soon");
    expect(String(init.body)).toContain("wNEAR");
  });
  it("returns NaN on unparseable output", async () => {
    vi.stubGlobal("fetch", reply("I think about one percent"));
    expect(await llmMarginAdvisor({ apiKey: "k", plan: "p" })({ holdings: {}, tokens })).toBeNaN();
  });
  it("throws on HTTP errors", async () => {
    vi.stubGlobal("fetch", reply("{}", 401));
    await expect(llmMarginAdvisor({ apiKey: "bad", plan: "p" })({ holdings: {}, tokens })).rejects.toThrow(/401/);
  });
  it("the runtime clamps whatever the model says to [0, 5%] and still prices offers deterministically", async () => {
    for (const [said, used] of [[0.9, 0.05], [-1, 0], [NaN, 0.01]] as const) {
      const a = new AgentRuntime(
        { id: "a", strategy: "spender", target: "U", margin: 0.003, verifierId: "v", marginAdvisor: async () => said },
        () => { throw new Error("must not sign during refresh"); },
        async () => ({ W: 10n ** 24n, U: 0n }),
        rngFrom(1),
      );
      const [o] = await a.refresh(tokens, 0);
      // limit = mid * (1 - used); mid = 3.5 USDC per wNEAR
      const human = Number((o!.rateNum * 10n ** 24n) / o!.rateDen) / 1e6;
      expect(human).toBeCloseTo(3.5 * (1 - used), 5);
    }
  });
});
