import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { NearRpc } from '../src/rpc.js';

// A server that stalls before the headers (/head) or after them, mid-body (/body).
let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"jsonrpc":"2.0",'); // never finished
    } // '/head': never respond
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

for (const path of ['/head', '/body']) {
  test(`a stall ${path === '/head' ? 'before the headers' : 'mid-body'} becomes a retryable "fetch failed" RpcError`, async () => {
    const rpc = new NearRpc(base + path);
    rpc.timeoutMs = () => 200;
    // retries = 0: the raw error must already be the mapped one, which sendTx matches to fall back to waitTx
    await expect(rpc.call('send_tx', {}, 0)).rejects.toThrow(/fetch failed: client timeout on send_tx/);
  });
}
