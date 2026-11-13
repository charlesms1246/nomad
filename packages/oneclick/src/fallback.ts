// Live 1Click fallback (TECH_DOC §10): an offer unmatched after N rounds takes the 1Click route.
// Guarded by FALLBACK_LIVE=1 and mainnet only (1Click has no testnet). Nomad runs on testnet,
// so in this build the flow refuses before any request. Even when allowed, the deposit step is
// an injected callback with no default: this package never moves funds on its own.
import { request, quoteBody, type ClientOptions, type QuoteParams } from './client.js';

export type Network = 'testnet' | 'mainnet';

export type SwapStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export type FallbackOutcome =
  | { outcome: 'filled'; depositAddress: string; status: 'SUCCESS'; amountOut?: string; details: any }
  /** Funds came back to refundTo inside Intents; the offer should go back to the board. */
  | { outcome: 'refunded'; depositAddress: string; status: 'REFUNDED'; details: any }
  /** Terminal failure; the agent must check its Intents balance and alert a human. */
  | { outcome: 'failed'; depositAddress: string; status: 'FAILED' | 'INCOMPLETE_DEPOSIT'; details: any }
  | { outcome: 'timeout'; depositAddress: string; status: SwapStatus; details: any };

export class FallbackRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FallbackRefused';
  }
}

export interface FallbackOptions extends ClientOptions {
  network?: Network;
  /** Defaults to process.env.FALLBACK_LIVE === '1'. */
  live?: boolean;
  /**
   * Moves `amount` of originAsset to `depositAddress` inside Intents (a fee-free `transfer`
   * intent) and returns the tx hash. No default: without it the flow refuses.
   */
  deposit?: (args: { depositAddress: string; originAsset: string; amount: string }) => Promise<string>;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Throws FallbackRefused unless live fallback is allowed on this network. */
export function assertFallbackAllowed(opts: Pick<FallbackOptions, 'network' | 'live'> = {}): void {
  const network = opts.network ?? ((process.env.NEAR_NETWORK as Network) || 'testnet');
  const live = opts.live ?? process.env.FALLBACK_LIVE === '1';
  if (network !== 'mainnet') {
    throw new FallbackRefused(
      `1Click fallback is mainnet-only; refusing on ${network}. Nomad runs on testnet, so unmatched offers get a dry-quote baseline only.`,
    );
  }
  if (!live) throw new FallbackRefused('1Click live fallback is disabled; set FALLBACK_LIVE=1 (human-enabled) to allow it.');
}

/** GET /v0/status?depositAddress=… */
export async function getStatus(depositAddress: string, opts: ClientOptions = {}): Promise<{ status: SwapStatus; raw: any }> {
  const raw = await request(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {}, opts);
  return { status: raw.status, raw };
}

/** Poll status until terminal; maps REFUNDED / FAILED / INCOMPLETE_DEPOSIT / SUCCESS to outcomes. */
export async function waitForOutcome(depositAddress: string, opts: FallbackOptions = {}): Promise<FallbackOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let last: { status: SwapStatus; raw: any } = { status: 'PENDING_DEPOSIT', raw: null };
  while (Date.now() < deadline) {
    last = await getStatus(depositAddress, opts);
    switch (last.status) {
      case 'SUCCESS':
        return {
          outcome: 'filled',
          depositAddress,
          status: 'SUCCESS',
          amountOut: last.raw?.swapDetails?.amountOut,
          details: last.raw,
        };
      case 'REFUNDED':
        return { outcome: 'refunded', depositAddress, status: 'REFUNDED', details: last.raw };
      case 'FAILED':
      case 'INCOMPLETE_DEPOSIT':
        return { outcome: 'failed', depositAddress, status: last.status, details: last.raw };
      default:
        await sleep(opts.pollMs ?? 3_000);
    }
  }
  return { outcome: 'timeout', depositAddress, status: last.status, details: last.raw };
}

/**
 * quote (non-dry) → deposit (injected) → submit tx hash → poll status.
 * Refuses on testnet, without FALLBACK_LIVE=1, or without a deposit callback, before any request.
 */
export async function runFallback(p: QuoteParams, opts: FallbackOptions = {}): Promise<FallbackOutcome> {
  assertFallbackAllowed(opts);
  if (!opts.deposit) {
    throw new FallbackRefused('1Click live fallback has no deposit executor wired; this build never executes swaps.');
  }
  const res = await request('/v0/quote', { method: 'POST', body: quoteBody(p, false) }, opts);
  const depositAddress: string | undefined = res?.quote?.depositAddress;
  if (!depositAddress) throw new Error('1Click quote has no depositAddress');
  const txHash = await opts.deposit({ depositAddress, originAsset: p.originAsset, amount: p.amount.toString() });
  await request('/v0/deposit/submit', { method: 'POST', body: { txHash, depositAddress } }, opts);
  return waitForOutcome(depositAddress, opts);
}
