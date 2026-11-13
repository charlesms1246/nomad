// Minimal NEAR JSON-RPC client over fetch, with retries. No near-api-js.

export type Network = 'testnet' | 'mainnet';

export const RPC_URLS: Record<Network, string> = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
};

/** The Verifier (intents) contract colo targets by default on each network. */
export const DEFAULT_TARGET: Record<Network, string> = {
  testnet: 'intents.nomadswarm.testnet',
  mainnet: 'intents.near',
};

export function parseNetwork(v: string | undefined): Network {
  const n = (v ?? 'testnet').toLowerCase();
  if (n !== 'testnet' && n !== 'mainnet') throw new Error(`unknown network "${v}" (use testnet or mainnet)`);
  return n;
}

/** Resolve an RPC URL: explicit url > network default. */
export function rpcUrlFor(network: Network = 'testnet', override?: string): string {
  return override || RPC_URLS[network];
}

export class RpcError extends Error {
  constructor(message: string, public readonly data: unknown, public readonly causeName?: string) {
    super(message);
    this.name = 'RpcError';
  }
}

let rid = 0;

export interface RpcOptions {
  retries?: number;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. Default 15 s. */
  timeoutMs?: number;
}

/** Call a JSON-RPC method. Handler errors (e.g. UNKNOWN_ACCOUNT) are thrown immediately, transport errors are retried. */
export async function rpc<T = any>(url: string, method: string, params: unknown, opts: RpcOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const f = opts.fetchImpl ?? fetch;
  let last: unknown;
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers.get('retry-after'));
        throw Object.assign(new Error(`${method}: HTTP ${r.status}`), { retryAfterMs: ra > 0 ? ra * 1000 : 0 });
      }
      const j: any = await r.json();
      if (j.error) {
        const causeName: string | undefined = j.error?.cause?.name;
        throw new RpcError(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`, j.error, causeName);
      }
      // Some nodes report view errors inside result.error instead of error.
      if (j.result && typeof j.result.error === 'string') {
        const unknown = /does not exist|UNKNOWN_ACCOUNT/i.test(j.result.error);
        throw new RpcError(`${method}: ${j.result.error}`, j.result, unknown ? 'UNKNOWN_ACCOUNT' : undefined);
      }
      return j.result as T;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      last = e;
      // Exponential backoff (0.5 s, 1 s, 2 s, …), or the server's Retry-After if longer.
      const wait = Math.max(500 * 2 ** a, (e as any)?.retryAfterMs ?? 0);
      if (a < retries) await new Promise((res) => setTimeout(res, wait));
    }
  }
  throw last;
}

/** True if `view_account` says the account does not exist (UNKNOWN_ACCOUNT). */
export async function accountIsFree(url: string, accountId: string, opts: RpcOptions = {}): Promise<boolean> {
  try {
    await rpc(url, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId }, opts);
    return false;
  } catch (e) {
    if (e instanceof RpcError && e.causeName === 'UNKNOWN_ACCOUNT') return true;
    throw e;
  }
}
