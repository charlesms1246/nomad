// LLM=1 stretch (TECH_DOC §8): NEAR AI Cloud (OpenAI-compatible, TEE-hosted) picks the agent's
// pricing margin from a written spending plan. It only returns a number; the deterministic
// legCheck still decides every signature, and the margin is clamped to [0, 5%].
import type { TokenInfo } from "./strategies.js";
import type { TokenId } from "./protocol.js";

export interface LlmOpts {
  apiKey: string;
  baseUrl?: string; // default https://cloud-api.near.ai/v1
  model?: string;
  plan: string; // e.g. "I pay ~$1/day for inference in USDC; I can wait a few minutes for a better rate."
  timeoutMs?: number;
}

export function llmMarginAdvisor(o: LlmOpts) {
  return async (ctx: { holdings: Record<TokenId, bigint>; tokens: TokenInfo[] }): Promise<number> => {
    const holdings = ctx.tokens
      .map((t) => ({ symbol: t.symbol, usd: (Number(ctx.holdings[t.id] ?? 0n) / 10 ** t.decimals) * t.priceUsd }))
      .filter((h) => h.usd > 0);
    const body = {
      model: o.model ?? process.env.NEARAI_MODEL ?? "deepseek-ai/DeepSeek-V3.1",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You set the pricing margin for a trading agent. Reply with JSON only: {\"margin\": <number between 0 and 0.05>}. " +
            "Margin is the discount below mid price the agent accepts. Urgent spending needs a higher margin; patient agents use a lower one.",
        },
        { role: "user", content: JSON.stringify({ plan: o.plan, holdings }) },
      ],
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    try {
      const r = await fetch(`${o.baseUrl ?? "https://cloud-api.near.ai/v1"}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`NEAR AI Cloud HTTP ${r.status}`);
      const j: any = await r.json();
      const text: string = j.choices?.[0]?.message?.content ?? "";
      const m = text.match(/"margin"\s*:\s*([0-9.]+)/);
      return m ? parseFloat(m[1]!) : NaN;
    } finally {
      clearTimeout(t);
    }
  };
}
