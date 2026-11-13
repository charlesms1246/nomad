// Live 1Click test (mainnet API, dry quote only, nothing executes). Run with ONECLICK_LIVE=1.
import { describe, expect, it } from 'vitest';
import { baseline, dryQuote, getTokens } from '../src/index.js';

const live = process.env.ONECLICK_LIVE === '1';

describe.skipIf(!live)('1Click live', () => {
  it('tokens include the mapped assets', async () => {
    const ts = await getTokens();
    for (const id of ['nep141:wrap.near', 'nep141:usdt.tether-token.near', 'nep141:btc.omft.near', 'nep141:zec.omft.near']) {
      expect(ts.some((t) => t.id === id)).toBe(true);
    }
  }, 30_000);

  it('dry quote 1 wNEAR → USDC and a baseline', async () => {
    const q = await dryQuote({ originAsset: 'nep141:wrap.near', destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', amount: 10n ** 24n });
    expect(BigInt(q.amountOut)).toBeGreaterThan(0n);
    const b = await baseline({ give: 'wNEAR', giveAmt: 10n ** 24n, get: 'USDC', getAmt: BigInt(q.amountOut) });
    console.log(JSON.stringify({ amountOut: q.amountOut, minAmountOut: q.minAmountOut, appFees: q.appFees, timestamp: q.timestamp, baseline: { ...b, quote: undefined } }));
  }, 30_000);
});
