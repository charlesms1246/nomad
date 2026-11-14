// Regenerates test/fixtures/erc7683-vector.json (the golden vector the Rust side loads).
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  buildLegOrder, domainSeparator, EIP712_DOMAIN_TYPE, EIP712_DOMAIN_TYPEHASH, evmAddress, GASLESS_ORDER_TYPE, GASLESS_ORDER_TYPEHASH,
  NOMAD_LEG_TYPE, NOMAD_LEG_TYPEHASH, nomadDomain, orderDigest, orderStructHash, signOrder,
} from '../src/erc7683.js';

const hex = (b: Uint8Array) => '0x' + bytesToHex(b);
// Fixed test key: keccak256("nomad erc7683 test key"). Never fund it.
const priv = keccak_256(new TextEncoder().encode('nomad erc7683 test key'));
const user = evmAddress(secp256k1.getPublicKey(priv, false));
const domain = nomadDomain('testnet');
const leg = { give: 'nep141:usdc.nomadswarm.testnet', giveAmount: 1_000_000n, want: 'nep141:wnear.nomadswarm.testnet', minWantAmount: 285_000_000_000_000_000_000_000n };
const nonce = BigInt('0x5628f6c600672865c100d0f1c4a1e3e7180102030405060708090a0b0c0d0e0f'); // versioned-nonce-shaped, fixed
const order = buildLegOrder({ leg, nonce, user, openDeadline: 1794700000, fillDeadline: 1794700120, domain });
const sig = signOrder(order, domain, priv);
const vector = {
  note: 'ERC-7683 (earlier draft) GaslessCrossChainOrder for one Nomad leg, EIP-712 signed. Conventions: packages/intents/src/erc7683.ts. Regenerate: pnpm --filter @nomad/intents exec tsx scripts/erc7683-vector.ts',
  types: { EIP712Domain: EIP712_DOMAIN_TYPE, GaslessCrossChainOrder: GASLESS_ORDER_TYPE, NomadLeg: NOMAD_LEG_TYPE },
  typehashes: { EIP712Domain: hex(EIP712_DOMAIN_TYPEHASH), GaslessCrossChainOrder: hex(GASLESS_ORDER_TYPEHASH), NomadLeg: hex(NOMAD_LEG_TYPEHASH) },
  domain: { name: domain.name, version: domain.version, chainId: domain.chainId.toString(), verifyingContract: domain.verifyingContract },
  domainSeparator: hex(domainSeparator(domain)),
  leg: { give: leg.give, giveAmount: leg.giveAmount.toString(), want: leg.want, minWantAmount: leg.minWantAmount.toString() },
  order: {
    originSettler: order.originSettler, user: order.user, nonce: order.nonce.toString(), originChainId: order.originChainId.toString(),
    openDeadline: order.openDeadline, fillDeadline: order.fillDeadline, orderDataType: hex(order.orderDataType), orderData: hex(order.orderData),
  },
  orderDataHash: hex(keccak_256(order.orderData)),
  structHash: hex(orderStructHash(order)),
  digest: hex(orderDigest(order, domain)),
  signingKey: { privateKey: hex(priv), address: user, warning: 'test key, public, never fund' },
  signature: sig,
};
writeFileSync(new URL('../test/fixtures/erc7683-vector.json', import.meta.url), JSON.stringify(vector, null, 2) + '\n');
console.log(JSON.stringify(vector, null, 2));
