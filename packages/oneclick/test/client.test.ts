import { afterEach, describe, expect, it, vi } from 'vitest';
import { dryQuote, getTokens, OneClickError, quoteBody } from '../src/client.js';
import { mockFetch, QUOTE_1_WNEAR_USDC } from './mock.js';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

afterEach(() => vi.unstubAllEnvs());

describe('getTokens', () => {
  it('maps /v0/tokens rows to id, symbol, decimals, price', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/v0/tokens': () => ({ body: [{ assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 3.54, priceUpdatedAt: 'x', contractAddress: 'wrap.near' }] }),
    });
    expect(await getTokens({ fetchImpl })).toEqual([{ id: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, price: 3.54, blockchain: 'near' }]);
    expect(calls[0]).toMatchObject({ url: 'https://1click.chaindefuser.com/v0/tokens', method: 'GET' });
  });
});

describe('dryQuote', () => {
  it('sends the probe request shape and parses the reply', async () => {
    const { fetchImpl, calls } = mockFetch({ '/v0/quote': () => ({ status: 201, body: QUOTE_1_WNEAR_USDC }) });
    const before = Date.now();
    const q = await dryQuote({ originAsset: 'nep141:wrap.near', destinationAsset: USDC, amount: 10n ** 24n }, { fetchImpl, jwt: '' });
    const b = calls[0].body;
    expect(calls[0].method).toBe('POST');
    expect(b).toMatchObject({
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
      depositType: 'INTENTS', refundType: 'INTENTS', recipientType: 'INTENTS',
      originAsset: 'nep141:wrap.near', destinationAsset: USDC, amount: '1000000000000000000000000',
    });
    expect(b.refundTo).toBe(b.recipient);
    const dl = Date.parse(b.deadline) - before;
    expect(dl).toBeGreaterThan(9.9 * 60_000);
    expect(dl).toBeLessThan(10.1 * 60_000);
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(q).toMatchObject({ amountOut: '3527938', minAmountOut: '3492658', timestamp: '2026-11-13T20:47:08.595Z', appFees: [{ fee: 20 }] });
  });

  it('sends ONECLICK_JWT as a bearer token', async () => {
    vi.stubEnv('ONECLICK_JWT', 'abc.def');
    const { fetchImpl, calls } = mockFetch({ '/v0/quote': () => ({ body: QUOTE_1_WNEAR_USDC }) });
    await dryQuote({ originAsset: 'a', destinationAsset: 'b', amount: '1' }, { fetchImpl });
    expect(calls[0].headers.authorization).toBe('Bearer abc.def');
  });

  it('raises OneClickError with the server message', async () => {
    const { fetchImpl } = mockFetch({ '/v0/quote': () => ({ status: 400, body: { message: 'Amount is too low for bridge' } }) });
    await expect(dryQuote({ originAsset: 'a', destinationAsset: 'b', amount: '1' }, { fetchImpl })).rejects.toThrow(OneClickError);
    await expect(dryQuote({ originAsset: 'a', destinationAsset: 'b', amount: '1' }, { fetchImpl })).rejects.toThrow(/too low/);
  });

  it('quoteBody can build a non-dry body (fallback only)', () => {
    expect(quoteBody({ originAsset: 'a', destinationAsset: 'b', amount: 5n }, false).dry).toBe(false);
  });
});
