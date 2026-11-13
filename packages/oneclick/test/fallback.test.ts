import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertFallbackAllowed, FallbackRefused, runFallback, waitForOutcome } from '../src/fallback.js';
import { mockFetch } from './mock.js';

const P = { originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:usdt.tether-token.near', amount: '1' };
afterEach(() => vi.unstubAllEnvs());

describe('fallback guard', () => {
  it('refuses on testnet even with FALLBACK_LIVE=1, before any request', async () => {
    vi.stubEnv('FALLBACK_LIVE', '1');
    const { fetchImpl, calls } = mockFetch({});
    await expect(runFallback(P, { network: 'testnet', fetchImpl, deposit: async () => 'h' })).rejects.toThrow(/mainnet-only; refusing on testnet/);
    expect(calls).toHaveLength(0);
  });
  it('defaults to testnet and refuses', () => {
    expect(() => assertFallbackAllowed()).toThrow(FallbackRefused);
  });
  it('refuses on mainnet without FALLBACK_LIVE=1', () => {
    vi.stubEnv('FALLBACK_LIVE', '0');
    expect(() => assertFallbackAllowed({ network: 'mainnet' })).toThrow(/FALLBACK_LIVE=1/);
  });
  it('refuses when no deposit executor is wired', async () => {
    const { fetchImpl, calls } = mockFetch({});
    await expect(runFallback(P, { network: 'mainnet', live: true, fetchImpl })).rejects.toThrow(/never executes/);
    expect(calls).toHaveLength(0);
  });
});

describe('quote → status flow (mocked)', () => {
  const flow = (statuses: string[]) => {
    let i = 0;
    return mockFetch({
      '/v0/quote': () => ({ status: 201, body: { quote: { depositAddress: 'dep1', amountOut: '9' }, timestamp: 't' } }),
      '/v0/deposit/submit': () => ({ body: { status: 'KNOWN_DEPOSIT_TX' } }),
      '/v0/status': () => ({ body: { status: statuses[Math.min(i++, statuses.length - 1)], swapDetails: { amountOut: '9' } } }),
    });
  };
  const opts = (fetchImpl: typeof fetch) => ({ network: 'mainnet' as const, live: true, fetchImpl, deposit: async () => 'txhash', sleep: async () => {}, pollMs: 0 });

  it('SUCCESS → filled', async () => {
    const { fetchImpl, calls } = flow(['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']);
    const r = await runFallback(P, opts(fetchImpl));
    expect(r).toMatchObject({ outcome: 'filled', depositAddress: 'dep1', amountOut: '9' });
    expect(calls[0].body.dry).toBe(false);
    expect(calls[1].body).toEqual({ txHash: 'txhash', depositAddress: 'dep1' });
  });
  it('REFUNDED → refunded', async () => {
    const { fetchImpl } = flow(['PROCESSING', 'REFUNDED']);
    expect(await runFallback(P, opts(fetchImpl))).toMatchObject({ outcome: 'refunded', status: 'REFUNDED' });
  });
  it('FAILED and INCOMPLETE_DEPOSIT → failed', async () => {
    expect(await runFallback(P, opts(flow(['FAILED']).fetchImpl))).toMatchObject({ outcome: 'failed', status: 'FAILED' });
    expect(await runFallback(P, opts(flow(['INCOMPLETE_DEPOSIT']).fetchImpl))).toMatchObject({ outcome: 'failed', status: 'INCOMPLETE_DEPOSIT' });
  });
  it('times out while still processing', async () => {
    const { fetchImpl } = flow(['PROCESSING']);
    const r = await waitForOutcome('dep1', { fetchImpl, timeoutMs: 5, pollMs: 0, sleep: () => new Promise((res) => setTimeout(res, 2)) });
    expect(r).toMatchObject({ outcome: 'timeout', status: 'PROCESSING' });
  });
});
