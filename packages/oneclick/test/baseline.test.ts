import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseline, removeAppFee, savingsBps } from '../src/baseline.js';
import { buildTokenMap, configureTokens, rescale, resolveToken, tokenMap } from '../src/tokens.js';
import { mockFetch, QUOTE_1_WNEAR_USDC } from './mock.js';

afterEach(() => { vi.unstubAllEnvs(); configureTokens(); });

describe('token map', () => {
  it('has the five mainnet assets', () => {
    const m = buildTokenMap();
    expect(m.map((t) => [t.symbol, t.assetId, t.decimals])).toEqual([
      ['wNEAR', 'nep141:wrap.near', 24],
      ['USDC', 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 6],
      ['USDT', 'nep141:usdt.tether-token.near', 6],
      ['BTC', 'nep141:btc.omft.near', 8],
      ['ZEC', 'nep141:zec.omft.near', 8],
    ]);
  });
  it('testnet ids are configurable (args and NOMAD_TESTNET_TOKENS)', () => {
    vi.stubEnv('NOMAD_TESTNET_TOKENS', JSON.stringify({ wNEAR: 'nep141:wrap.testnet' }));
    configureTokens({ USDC: { testnetId: 'nep141:usdc.x.testnet', testnetDecimals: 18 } });
    expect(resolveToken('nep141:wrap.testnet')?.assetId).toBe('nep141:wrap.near');
    expect(resolveToken('nep141:usdc.x.testnet')).toMatchObject({ symbol: 'USDC', testnetDecimals: 18, decimals: 6 });
    expect(resolveToken('usdt')?.testnetId).toBe('nep141:usdt.nomadswarm.testnet');
    expect(tokenMap()).toHaveLength(5);
  });
  it('rescale', () => {
    expect(rescale(1_000_000_000_000_000_000n, 18, 6)).toBe(1_000_000n);
    expect(rescale(5n, 6, 8)).toBe(500n);
  });
});

describe('savings', () => {
  it('savingsBps = (ring − quote)/quote × 1e4', () => {
    expect(savingsBps(3_600_000n, 3_527_938n)).toBe(204.26);
    expect(savingsBps(3_527_938n, 3_527_938n)).toBe(0);
    expect(savingsBps(3_500_000n, 3_527_938n)).toBe(-79.19);
  });
  it('removeAppFee adds the 20 bps back', () => {
    expect(removeAppFee(3_527_938n, 20)).toBe(3_535_008n);
    expect(removeAppFee(100n, 0)).toBe(100n);
  });
});

describe('baseline', () => {
  it('quotes give→get at giveAmt and reports savings with and without the app fee', async () => {
    const { fetchImpl, calls } = mockFetch({ '/v0/quote': () => ({ status: 201, body: QUOTE_1_WNEAR_USDC }) });
    const b = await baseline(
      { give: 'nep141:wnear.nomadswarm.testnet', giveAmt: 10n ** 24n, get: 'nep141:usdc.nomadswarm.testnet', getAmt: 3_560_000n },
      { fetchImpl },
    );
    expect(calls[0].body).toMatchObject({ originAsset: 'nep141:wrap.near', amount: '1000000000000000000000000' });
    expect(b).toMatchObject({ quoteAmountOut: '3527938', appFeeBps: 20, quoteAmountOutNoFee: '3535008', ringAmountOut: '3560000' });
    expect(b.savingsBps).toBe(90.88);
    expect(b.savingsBpsNoFee).toBe(70.69);
    expect(b.timestamp).toBe('2026-11-13T20:47:08.595Z');
  });
  it('rescales when the testnet token has other decimals', async () => {
    const { fetchImpl, calls } = mockFetch({ '/v0/quote': () => ({ body: QUOTE_1_WNEAR_USDC }) });
    const tokens = buildTokenMap({ USDC: { testnetDecimals: 18 } });
    const b = await baseline({ give: 'wNEAR', giveAmt: '1000000000000000000000000', get: 'USDC', getAmt: 3_527_938n * 10n ** 12n }, { fetchImpl, tokens });
    expect(calls[0].body.amount).toBe('1000000000000000000000000');
    expect(b.savingsBps).toBe(0);
  });
  it('rejects unmapped testnet tokens', async () => {
    await expect(baseline({ give: 'nep141:foo.testnet', giveAmt: 1n, get: 'USDC', getAmt: 1n })).rejects.toThrow(/no 1Click asset/);
  });
});
