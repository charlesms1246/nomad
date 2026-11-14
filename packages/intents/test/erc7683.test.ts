import { readFileSync } from 'node:fs';
import { hexToBytes } from '@noble/hashes/utils';
import { expect, test } from 'vitest';
import {
  domainSeparator, encodeNomadLeg, GASLESS_ORDER_TYPEHASH, NOMAD_LEG_TYPEHASH, nomadDomain, orderDigest, recoverOrderSigner, signOrder,
  type GaslessCrossChainOrder,
} from '../src/erc7683.js';

// Golden vector, cross-checked on 2026-11-14 against viem 2.57.19 (encodeAbiParameters, hashDomain,
// hashTypedData, signTypedData, recoverTypedDataAddress): every field matched byte for byte.
const v = JSON.parse(readFileSync(new URL('./fixtures/erc7683-vector.json', import.meta.url), 'utf8'));
const h = (s: string) => hexToBytes(s.slice(2));
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const domain = nomadDomain('testnet');
const order: GaslessCrossChainOrder = {
  ...v.order,
  nonce: BigInt(v.order.nonce),
  originChainId: BigInt(v.order.originChainId),
  orderDataType: h(v.order.orderDataType),
  orderData: h(v.order.orderData),
};

test('typehashes and domain separator match the vector', () => {
  expect(hex(GASLESS_ORDER_TYPEHASH)).toBe(v.typehashes.GaslessCrossChainOrder);
  expect(hex(NOMAD_LEG_TYPEHASH)).toBe(v.typehashes.NomadLeg);
  expect(hex(domainSeparator(domain))).toBe(v.domainSeparator);
  expect(v.domain.chainId).toBe('398'); // NEAR Protocol Testnet in the EIP-155 registry
});

test('orderData is abi.encode(string,uint256,string,uint256) of the leg', () => {
  const l = { give: v.leg.give, giveAmount: BigInt(v.leg.giveAmount), want: v.leg.want, minWantAmount: BigInt(v.leg.minWantAmount) };
  expect(hex(encodeNomadLeg(l))).toBe(v.order.orderData);
});

test('digest and signature are reproducible (RFC 6979, low-s, v in {27,28})', () => {
  expect(hex(orderDigest(order, domain))).toBe(v.digest);
  const sig = signOrder(order, domain, h(v.signingKey.privateKey));
  expect(sig).toEqual(v.signature);
  expect(recoverOrderSigner(order, domain, v.signature.rsv)).toBe(v.signingKey.address);
});

test('any change to the order or domain recovers a different address', () => {
  const tampered = { ...order, orderData: h(v.order.orderData.replace(/0f4240/, '0f4241')) }; // giveAmount 1000000 -> 1000001
  expect(recoverOrderSigner(tampered, domain, v.signature.rsv)).not.toBe(v.signingKey.address);
  expect(recoverOrderSigner(order, nomadDomain('mainnet'), v.signature.rsv)).not.toBe(v.signingKey.address);
  expect(recoverOrderSigner({ ...order, nonce: order.nonce + 1n }, domain, v.signature.rsv)).not.toBe(v.signingKey.address);
});
