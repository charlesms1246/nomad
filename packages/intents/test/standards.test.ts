import { describe, expect, it } from 'vitest';
import {
  anyIntentHash,
  b58decode,
  b58encode,
  erc191Recover,
  erc191Sign,
  ethAddressOf,
  ethImplicitAccountId,
  hexdecode,
  hexencode,
  normaliseErc191Signature,
  rawEd25519AccountId,
  signErc191TokenDiff,
  signRawEd25519TokenDiff,
  signTokenDiff,
  randomKeyPair,
  verifyAnyPayload,
  type SignedRawEd25519Payload,
} from '../src/index.js';

describe('erc191 (vectors from near/intents and web3.js)', () => {
  it('recovers the public key of the near/intents Erc191 test vector ("Hello world!")', () => {
    // crates/signatures/erc191/src/lib.rs `recover_ok`
    const pk = '85a66984273f338ce4ef7b85e5430b008307e8591bb7c1b980852cf6423770b801f41e9438155eb53a5e20f748640093bb42ae3aeca035f7b7fd7a1a21f22f68';
    const sig = hexdecode('7800a70d05cde2c49ed546a6ce887ce6027c2c268c0285f6efef0cdfc4366b23643790f67a86468ee8301ed12cfffcb07c6530f90a9327ec057800fabd332e4701');
    expect(hexencode(erc191Recover('Hello world!', sig))).toBe(pk);
  });

  it('derives the implicit 0x account like core/src/public_key.rs', () => {
    // `to_implicit_account_id` case: secp256k1:3aMVM… -> 0xbff77166…
    const pk = b58decode('3aMVMxsoAnHUbweXMtdKaN1uJaNwsfKv7wnc97SDGjXhyK62VyJwhPUPLZefKVthcoUcuWK6cqkSU4M542ipNxS3');
    expect(ethImplicitAccountId(pk)).toBe('0xbff77166b39599e54e391156eef7b8191e02be92');
  });

  it('matches web3.js personal_sign for its documented key (v normalised 28 -> 1)', () => {
    // web3.eth.accounts.sign("Some data", "0x4c0883…") docs example
    const key = hexdecode('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
    expect(ethAddressOf(key)).toBe('0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
    const web3Sig = 'b91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c';
    const ours = erc191Sign('Some data', key);
    expect(hexencode(ours)).toBe(hexencode(normaliseErc191Signature(hexdecode(web3Sig))));
    expect(ours[64]).toBe(1);
  });

  it('signs a token_diff whose payload has the DefusePayload fields and verifies locally', () => {
    const key = hexdecode('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
    const nonce = new Uint8Array(32).fill(7);
    const mp = signErc191TokenDiff({
      privateKey: key,
      verifierId: 'intents.nomadswarm.testnet',
      salt: '00000000',
      deadline: new Date('2030-01-01T00:00:00.000Z'),
      diff: { 'nep141:usdc.nomadswarm.testnet': '-1000', 'nep141:usdt.nomadswarm.testnet': '999' },
      nonce,
    });
    expect(mp.standard).toBe('erc191');
    expect(mp.payload).toBe(
      '{"signer_id":"0x2c7536e3605d9c16a7a3d7b1898e529396a65c23","verifying_contract":"intents.nomadswarm.testnet","deadline":"2030-01-01T00:00:00.000Z","nonce":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=","intents":[{"intent":"token_diff","diff":{"nep141:usdc.nomadswarm.testnet":"-1000","nep141:usdt.nomadswarm.testnet":"999"}}]}',
    );
    expect(mp.signature.startsWith('secp256k1:')).toBe(true);
    expect(b58decode(mp.signature.slice(10)).length).toBe(65);
    expect(verifyAnyPayload(mp)).toBe(true);
    // RFC 6979 makes it deterministic: pin the bytes.
    expect(mp.signature).toMatchInlineSnapshot(`"secp256k1:596cuAvm89tkhnsCRzqZ75sKDDDuvTAi91ewBn6qpjs5ZRUPGgS9sBEhRbc2cLBxWt9F9UQjf4FVbaPjRk8U87tL7"`);
    // Tampering with the payload changes the recovered signer.
    expect(verifyAnyPayload({ ...mp, payload: mp.payload.replace('999', '998') })).toBe(false);
  });
});

describe('raw_ed25519 (vectors from near/intents)', () => {
  it('verifies the multi.rs test payload and reproduces its intent hash', () => {
    // contracts/defuse/core/src/payload/multi.rs `raw_ed25519`
    const p: SignedRawEd25519Payload = {
      standard: 'raw_ed25519',
      payload:
        '{"signer_id":"74affa71ab030d400fdfa1bed033dfa6fd3ae34f92d17c046ebe368e80d53751","verifying_contract":"intents.near","deadline":{"timestamp":1732035219},"nonce":"XVoKfmScb3G+XqH9ke/fSlJ/3xO59sNhCxhpG821BH8=","intents":[{"intent":"token_diff","diff":{"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near":"-1000","nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near":"998"}}]}',
      public_key: 'ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN',
      signature: 'ed25519:3vtbNQJHZfuV1s5DykzyjkbNLc583hnkrhTz57eDhd966iqzkor6Twgr4Loh2C195SCSEsiGfrd6KcxpjNq9ZbVj',
    };
    expect(anyIntentHash(p)).toBe('8LKE47o44ybZQR9ozLyDnvMDTh4Ao5ipy2mJWsYByG5Q');
    expect(verifyAnyPayload(p)).toBe(true);
    expect(verifyAnyPayload({ ...p, payload: p.payload.replace('998', '999') })).toBe(false);
  });

  it('derives the implicit hex account like core/src/public_key.rs', () => {
    // ed25519:5Tagut… -> 423df0a6…
    expect(hexencode(b58decode('5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm'))).toBe('423df0a6640e9467769c55a573f15b9ee999dc8970048959c72890abf5cc3a8e');
  });

  it('signs a token_diff over the raw payload bytes, deterministically', () => {
    const seed = new Uint8Array(32).fill(1);
    const mp = signRawEd25519TokenDiff({
      seed,
      verifierId: 'intents.nomadswarm.testnet',
      salt: '00000000',
      deadline: new Date('2030-01-01T00:00:00.000Z'),
      diff: { 'nep141:zec.nomadswarm.testnet': '-5', 'nep141:usdc.nomadswarm.testnet': '4' },
      nonce: new Uint8Array(32).fill(9),
    });
    expect(JSON.parse(mp.payload).signer_id).toBe(rawEd25519AccountId(seed));
    expect(mp.public_key).toBe('ed25519:' + b58encode(hexdecode(rawEd25519AccountId(seed))));
    expect(verifyAnyPayload(mp)).toBe(true);
    expect(mp.signature).toMatchInlineSnapshot(`"ed25519:4trcEGb9jGBKcVDv1nqucnBdiLBFbTyUTLEBsDHXbHzU5WLRfBWYkMFn3XUHpVjSHqVhGf2cbtwkykoKNw71gEQj"`);
  });

  it('rejects zero amounts', () => {
    expect(() =>
      signRawEd25519TokenDiff({ seed: new Uint8Array(32), verifierId: 'v', salt: '00000000', deadline: new Date(), diff: { a: '0' } }),
    ).toThrow(/zero/);
  });
});

describe('mixed batches', () => {
  it('verifyAnyPayload accepts every standard in one batch and rejects a tampered nep413 leg', () => {
    const base = { verifierId: 'intents.nomadswarm.testnet', salt: '00000000', deadline: new Date('2030-01-01T00:00:00.000Z') };
    const kp = randomKeyPair();
    const nep = signTokenDiff({ ...base, signerId: 'a01.nomadswarm.testnet', secretKey: kp.secretKeyStr, diff: { a: '-2', b: '1' } });
    const eth = signErc191TokenDiff({ ...base, privateKey: new Uint8Array(32).fill(3), diff: { b: '-2', c: '1' } });
    const sol = signRawEd25519TokenDiff({ ...base, seed: new Uint8Array(32).fill(4), diff: { c: '-2', a: '1' } });
    expect([nep, eth, sol].map(verifyAnyPayload)).toEqual([true, true, true]);
    const bad = { ...nep, payload: { ...nep.payload, message: nep.payload.message.replace('"1"', '"2"') } };
    expect(verifyAnyPayload(bad)).toBe(false);
  });
});
