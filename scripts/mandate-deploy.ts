// Deploy the mandate contract (testnet only): first run creates mandate.<parent> with 3.5 NEAR,
// deploys contracts/mandate/target/near/nomad_mandate.wasm and calls new(); --redeploy replaces the code only.
// Build first: cd contracts/mandate && cargo near build non-reproducible-wasm
import { log } from './k-lib.js';
import { MANDATE_ID, derivedAddress, ensureDeployed } from './mandate-lib.js';

await ensureDeployed({ redeploy: process.argv.includes('--redeploy') });
const owner = process.argv.find((a) => a.startsWith('--owner='))?.slice(8);
if (owner) log(`derived signer_id for ${owner}: ${(await derivedAddress(owner)).address}`);
log(`${MANDATE_ID} ready`);
