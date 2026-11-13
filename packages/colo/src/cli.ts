#!/usr/bin/env node
// colo: place an account on a target contract's shard.
//   colo where <accountId>                       → shard id (live layout)
//   colo place <target> --parent P [--hint H]    → free sub-account of P on target's shard
//   colo check --account A [--target T]          → exit 0 if colocated, else 1
//   colo latency [--target T] [--blocks N]       → hop-latency JSON on stdout
// Global: --network testnet|mainnet (default testnet, or $NEAR_NETWORK), --rpc URL (or $RPC_URL), --json
import { check, where } from './index.js';
import { latency } from './latency.js';
import { place } from './place.js';
import { DEFAULT_TARGET, parseNetwork } from './rpc.js';

const USAGE = `usage:
  colo where <accountId>
  colo place <target> --parent P [--hint H]
  colo check --account A [--target T]
  colo latency [--target T] [--blocks N]
options: --network testnet|mainnet (default testnet)  --rpc URL  --json`;

export function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const [cmd, arg] = pos;
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  if (!cmd || flags.help || cmd === 'help') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const network = parseNetwork(str('network') ?? process.env.NEAR_NETWORK);
  // $RPC_URL only applies when it matches the chosen network's default; --rpc always wins.
  const rpcUrl = str('rpc') ?? (network === parseNetwork(process.env.NEAR_NETWORK) ? process.env.RPC_URL : undefined);
  const json = !!flags.json;
  const net = { network, rpcUrl };

  switch (cmd) {
    case 'where': {
      if (!arg) throw new Error('where: <accountId> required');
      const r = await where(arg, net);
      console.log(json ? JSON.stringify(r) : `${r.accountId} → shard ${r.shard} [${JSON.stringify(r.range.lo)}, ${JSON.stringify(r.range.hi)}) (${network})`);
      return 0;
    }
    case 'place': {
      const target = arg ?? str('target') ?? DEFAULT_TARGET[network];
      const parent = str('parent') ?? process.env.PARENT_ACCOUNT;
      if (!parent) throw new Error('place: --parent required');
      const r = await place(target, { parent, hint: str('hint'), ...net });
      if (json) console.log(JSON.stringify(r));
      else {
        console.log(r.accountId);
        console.error(
          `target ${r.target} is on shard ${r.targetShard}; ${r.accountId} → shard ${r.shard}` +
            (r.prefixed ? ` (prefixed "${r.prefixed}")` : '') +
            (r.tried.length ? `; skipped: ${r.tried.map((t) => `${t.accountId} (${t.reason})`).join(', ')}` : ''),
        );
      }
      return 0;
    }
    case 'check': {
      const account = str('account') ?? arg ?? process.env.MATCHER_ID;
      if (!account) throw new Error('check: --account required');
      const target = str('target') ?? process.env.VERIFIER_ID ?? DEFAULT_TARGET[network];
      const r = await check({ account, target }, net);
      console.log(
        json
          ? JSON.stringify(r)
          : `${r.colocated ? 'OK' : 'COLO_MISPLACED'}: ${r.account} shard ${r.accountShard}, ${r.target} shard ${r.targetShard}`,
      );
      return r.colocated ? 0 : 1;
    }
    case 'latency': {
      const blocks = str('blocks') ? Number(str('blocks')) : undefined;
      const r = await latency({ target: str('target') ?? arg, blocks, ...net });
      console.log(JSON.stringify(r, null, 1));
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`colo: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  },
);
