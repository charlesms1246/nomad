import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Credentials {
  account_id: string;
  public_key: string;
  private_key: string;
}

export const credentialsDir = (network = 'testnet') =>
  process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials', network);

/** Load a near-cli credential file (`~/.near-credentials/<network>/<account>.json`). */
export function loadCredentials(accountId: string, network = 'testnet'): Credentials {
  const f = join(credentialsDir(network), `${accountId}.json`);
  return JSON.parse(readFileSync(f, 'utf8')) as Credentials;
}

export function hasCredentials(accountId: string, network = 'testnet'): boolean {
  return existsSync(join(credentialsDir(network), `${accountId}.json`));
}

export function saveCredentials(c: Credentials, network = 'testnet'): string {
  const dir = credentialsDir(network);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${c.account_id}.json`);
  writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
  return f;
}

/** `{ signerId, secretKey }` for IntentsClient / NearRpc calls. */
export function signerFor(accountId: string, network = 'testnet') {
  const c = loadCredentials(accountId, network);
  return { signerId: c.account_id, secretKey: c.private_key };
}
