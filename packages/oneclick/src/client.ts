// 1Click API client (https://1click.chaindefuser.com). MAINNET API, used only for GETs and
// dry quotes here. Nothing in this module moves funds.

export const ONECLICK_URL = 'https://1click.chaindefuser.com';
/** Placeholder refund/recipient for dry quotes. A dry quote never deposits anything. */
export const PLACEHOLDER_ACCOUNT = 'nomadswarm.near';

export interface ClientOptions {
  baseUrl?: string;
  /** Bearer JWT; defaults to $ONECLICK_JWT. Without it 1Click adds a 20 bps app fee. */
  jwt?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OneClickError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
    this.name = 'OneClickError';
  }
}

export interface Token {
  id: string;
  symbol: string;
  decimals: number;
  price: number;
  blockchain?: string;
}

export interface AppFee {
  recipient: string;
  /** Basis points. */
  fee: number;
}

export interface DryQuote {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountOutUsd?: string;
  appFees: AppFee[];
  /** Server timestamp of the quote (ISO). */
  timestamp: string;
  originAsset: string;
  destinationAsset: string;
  correlationId?: string;
  raw: any;
}

export interface QuoteParams {
  originAsset: string;
  destinationAsset: string;
  /** Smallest units of originAsset, decimal string or bigint. */
  amount: string | bigint;
  slippageTolerance?: number;
  refundTo?: string;
  recipient?: string;
  /** Deadline; default now + 10 min. */
  deadline?: Date;
  /** Extra request fields (e.g. appFees, referral). */
  extra?: Record<string, unknown>;
}

function headers(opts: ClientOptions, json = false): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (json) h['content-type'] = 'application/json';
  const jwt = opts.jwt ?? process.env.ONECLICK_JWT;
  if (jwt) h.authorization = `Bearer ${jwt}`;
  return h;
}

export async function request<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  opts: ClientOptions = {},
): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const url = (opts.baseUrl ?? ONECLICK_URL) + path;
  const r = await f(url, {
    method: init.method ?? 'GET',
    headers: headers(opts, init.body !== undefined),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!r.ok) {
    const msg = typeof body === 'object' && body?.message ? body.message : String(text).slice(0, 300);
    throw new OneClickError(`1Click ${init.method ?? 'GET'} ${path} → ${r.status}: ${msg}`, r.status, body);
  }
  return body as T;
}

/** GET /v0/tokens → id, symbol, decimals, price (USD). */
export async function getTokens(opts: ClientOptions = {}): Promise<Token[]> {
  const rows = await request<any[]>('/v0/tokens', {}, opts);
  return rows.map((t) => ({
    id: t.assetId,
    symbol: t.symbol,
    decimals: t.decimals,
    price: Number(t.price),
    blockchain: t.blockchain,
  }));
}

/** Build the POST /v0/quote body for a quote (dry by default). */
export function quoteBody(p: QuoteParams, dry = true): Record<string, unknown> {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: p.slippageTolerance ?? 100,
    originAsset: p.originAsset,
    depositType: 'INTENTS',
    destinationAsset: p.destinationAsset,
    amount: p.amount.toString(),
    refundTo: p.refundTo ?? PLACEHOLDER_ACCOUNT,
    refundType: 'INTENTS',
    recipient: p.recipient ?? PLACEHOLDER_ACCOUNT,
    recipientType: 'INTENTS',
    deadline: (p.deadline ?? new Date(Date.now() + 10 * 60_000)).toISOString(),
    ...p.extra,
  };
}

export function parseQuote(res: any): DryQuote {
  const q = res?.quote;
  if (!q?.amountOut) throw new OneClickError('1Click quote response has no quote.amountOut', 200, res);
  return {
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    amountOutUsd: q.amountOutUsd,
    appFees: res.quoteRequest?.appFees ?? [],
    timestamp: res.timestamp,
    originAsset: res.quoteRequest?.originAsset,
    destinationAsset: res.quoteRequest?.destinationAsset,
    correlationId: res.correlationId,
    raw: res,
  };
}

/** POST /v0/quote with dry:true, EXACT_INPUT, INTENTS deposit/refund/recipient, 1% slippage. */
export async function dryQuote(p: QuoteParams, opts: ClientOptions = {}): Promise<DryQuote> {
  const res = await request('/v0/quote', { method: 'POST', body: quoteBody(p, true) }, opts);
  return parseQuote(res);
}
