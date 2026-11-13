#!/usr/bin/env node
// colo-mcp: stdio MCP server exposing colo_where, colo_place, colo_check.
// Default network: $NEAR_NETWORK or testnet. Each tool also takes an optional `network`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { check, where } from './index.js';
import { place } from './place.js';
import { parseNetwork, type Network } from './rpc.js';

const defaultNetwork = parseNetwork(process.env.NEAR_NETWORK);
const networkArg = z.enum(['testnet', 'mainnet']).optional().describe('NEAR network (default testnet)');

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `colo: ${e instanceof Error ? e.message : String(e)}` }],
});
const net = (n?: Network) => ({ network: n ?? defaultNetwork });

const server = new McpServer({ name: 'colo', version: '0.1.0' });

server.registerTool(
  'colo_where',
  {
    description: 'Return the NEAR shard id an account id maps to under the live shard layout (the account need not exist).',
    inputSchema: { accountId: z.string().describe('NEAR account id'), network: networkArg },
  },
  async ({ accountId, network }) => {
    try {
      return ok(await where(accountId, net(network)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'colo_place',
  {
    description:
      'Find a free sub-account name of `parent` that lands on the same shard as `target` (e.g. a matcher co-located with the Intents verifier). Read-only: it does not create the account.',
    inputSchema: {
      target: z.string().describe('Contract to co-locate with, e.g. intents.nomadswarm.testnet'),
      parent: z.string().describe('Parent account, e.g. nomadswarm.testnet'),
      hint: z.string().optional().describe('Preferred sub-account label (default "matcher")'),
      network: networkArg,
    },
  },
  async ({ target, parent, hint, network }) => {
    try {
      return ok(await place(target, { parent, hint, ...net(network) }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'colo_check',
  {
    description: 'Check whether `account` is on the same shard as `target`. Returns both shards and `colocated`.',
    inputSchema: {
      account: z.string().describe('Account to check'),
      target: z.string().optional().describe('Target contract (default: the network verifier)'),
      network: networkArg,
    },
  },
  async ({ account, target, network }) => {
    try {
      return ok(await check({ account, target }, net(network)));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
