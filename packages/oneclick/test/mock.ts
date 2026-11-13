import { vi } from 'vitest';

export type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** A fetch mock that records calls and answers from a route table. */
export function mockFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: any = {}) => {
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const { status = 200, body } = routes[key](call);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

// Recorded 2026-11-13 (docs/spec/supplementary/probes/data/1click-dry-quote-2026-11-13.txt), trimmed.
export const QUOTE_1_WNEAR_USDC = {
  quote: { amountIn: '1000000000000000000000000', amountInFormatted: '1.0', amountInUsd: '3.54', minAmountIn: '1000000000000000000000000', amountOut: '3527938', amountOutFormatted: '3.527938', amountOutUsd: '3.526290452954', minAmountOut: '3492658', timeEstimate: 12, refundFee: '0', withdrawFee: '0' },
  quoteRequest: { dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: 'nep141:wrap.near', depositType: 'INTENTS', destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', amount: '1000000000000000000000000', appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 20 }] },
  signature: 'ed25519:x',
  timestamp: '2026-11-13T20:47:08.595Z',
  correlationId: 'dc3c04c8-56b8-4173-a05f-a3fe0746bf41',
};
