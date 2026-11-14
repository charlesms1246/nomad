use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const USDC: &str = "nep141:usdc.nomadswarm.testnet";
const USDT: &str = "nep141:usdt.nomadswarm.testnet";
const BTC: &str = "nep141:btc.nomadswarm.testnet";
const NOW_MS: u64 = 1_763_130_000_000; // 2025-11-14T14:20:00Z
const SALT: &str = "a1b2c3d4";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("mandate.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .block_timestamp(now_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn nonce(salt: &str, deadline_ms: u64, tag: u8) -> Base64VecU8 {
    let mut n = Vec::with_capacity(32);
    n.extend_from_slice(&NONCE_MAGIC);
    n.push(0);
    n.extend_from_slice(&unhex(salt).unwrap());
    n.extend_from_slice(&((deadline_ms as i64) * 1_000_000).to_le_bytes());
    n.extend_from_slice(&[tag; 15]);
    Base64VecU8(n)
}

fn key() -> SigningKey {
    SigningKey::from_slice(&[7u8; 32]).unwrap()
}

fn addr_of(k: &SigningKey) -> String {
    let pt = k.verifying_key().to_encoded_point(false);
    let pk: [u8; 64] = pt.as_bytes()[1..].try_into().unwrap();
    eth_address_of(&pk)
}

fn args(addr: &str) -> MandateArgs {
    MandateArgs {
        eth_address: addr.to_string(),
        tokens: vec![
            TokenRule { token: USDC.into(), max_per_leg: U128(1_000_000), daily_budget: U128(2_500_000) },
            TokenRule { token: USDT.into(), max_per_leg: U128(1_000_000), daily_budget: U128(2_500_000) },
        ],
        prices: vec![PriceRule { give: USDC.into(), want: USDT.into(), rate_num: U128(99), rate_den: U128(100) }],
        min_counterparty_reputation: Some(10),
        expires_at_ms: NOW_MS + 7 * DAY_MS,
    }
}

fn leg(give_amount: u128, get_amount: u128, tag: u8) -> Leg {
    let deadline_ms = NOW_MS + 600_000;
    Leg {
        owner: acc("alice.testnet"),
        give: USDC.into(),
        give_amount: U128(give_amount),
        get: USDT.into(),
        get_amount: U128(get_amount),
        deadline_ms,
        nonce: nonce(SALT, deadline_ms, tag),
        salt: SALT.into(),
        tip: None,
    }
}

fn mandate(addr: &str) -> Mandate {
    let a = args(addr);
    Mandate {
        owner: acc("alice.testnet"),
        path: "mandate/alice.testnet".into(),
        eth_address: a.eth_address,
        address_verified: false,
        tokens: a.tokens,
        prices: a.prices,
        min_counterparty_reputation: a.min_counterparty_reputation,
        expires_at_ms: a.expires_at_ms,
        spent: vec![],
        legs_signed: 0,
    }
}

fn setup() -> (Contract, SigningKey) {
    let k = key();
    ctx("alice.testnet", MANDATE_DEPOSIT, NOW_MS);
    let mut c = Contract::new(acc("intents.nomadswarm.testnet"), acc("v1.signer-prod.testnet"));
    c.set_mandate(args(&addr_of(&k)));
    (c, k)
}

/// What the MPC would answer for this leg, signed with `k`.
fn mpc_response(c: &Contract, id: u64, k: &SigningKey, flip_hint: bool) -> Value {
    let l = c.legs.get(&id).unwrap();
    let prehash = unhex(&l.prehash).unwrap();
    let (sig, rid) = k.sign_prehash_recoverable(&prehash).unwrap();
    let b = sig.to_bytes();
    let mut big_r = vec![if rid.is_y_odd() { 3u8 } else { 2 }];
    big_r.extend_from_slice(&b[..32]);
    let v = rid.to_byte() ^ (flip_hint as u8);
    json!({"scheme": "Secp256k1", "big_r": {"affine_point": hex(&big_r)}, "s": {"scalar": hex(&b[32..])}, "recovery_id": v})
}

// ---------- pure helpers ----------

#[test]
fn rfc3339_formats() {
    assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(rfc3339_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(rfc3339_ms(1_763_130_000_123), "2025-11-14T14:20:00.123Z");
    assert_eq!(rfc3339_ms(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
}

#[test]
fn price_exact_and_wide() {
    assert!(price_ok(100, 99, 99, 100));
    assert!(!price_ok(100, 98, 99, 100));
    // 10^30 * 10^30 overflows u128; the 256-bit compare must still be exact.
    let big = 10u128.pow(30);
    assert!(price_ok(big, big, big, big));
    assert!(!price_ok(big, big - 1, big, big));
    assert!(price_ok(big, big + 1, big, big));
    for (a, b) in [(u128::MAX, 2u128), (u128::MAX, u128::MAX), (1 << 64, 1 << 64), (12345, 67890)] {
        let (hi, lo) = mul_wide(a, b);
        let x = a as u128;
        if let Some(p) = x.checked_mul(b) {
            assert_eq!((hi, lo), (0, p));
        } else {
            assert!(hi > 0);
        }
    }
    assert_eq!(mul_wide(u128::MAX, u128::MAX), (u128::MAX - 1, 1));
}

#[test]
fn eth_address_shape() {
    assert!(is_eth_address("0x991543dd33bcf06563cd14a67decf1834fe6bf9b"));
    assert!(!is_eth_address("0x991543DD33bcf06563cd14a67decf1834fe6bf9b"));
    assert!(!is_eth_address("991543dd33bcf06563cd14a67decf1834fe6bf9b00"));
}

#[test]
fn payload_is_the_verifier_shape() {
    ctx("x.testnet", NearToken::from_yoctonear(0), NOW_MS);
    let mut l = leg(100_000, 99_999, 1);
    l.tip = Some(Tip { token: USDT.into(), amount: U128(5), receiver_id: acc("matcher.testnet") });
    let p = build_payload(&l, "0xabc", &acc("intents.nomadswarm.testnet"));
    let v: Value = serde_json::from_str(&p).unwrap();
    assert_eq!(v["signer_id"], "0xabc");
    assert_eq!(v["verifying_contract"], "intents.nomadswarm.testnet");
    assert_eq!(v["deadline"], rfc3339_ms(l.deadline_ms));
    assert_eq!(v["nonce"], near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, &l.nonce.0));
    assert_eq!(v["intents"][0], json!({"intent": "token_diff", "diff": {USDC: "-100000", USDT: "99999"}}));
    assert_eq!(v["intents"][1], json!({"intent": "transfer", "receiver_id": "matcher.testnet", "tokens": {USDT: "5"}}));
}

#[test]
fn erc191_prehash_known_vector() {
    // defuse-erc191 test vector: "Hello world!" signed by the key below, v = 1.
    ctx("x.testnet", NearToken::from_yoctonear(0), NOW_MS);
    let h = erc191_prehash("Hello world!");
    let sig = unhex("7800a70d05cde2c49ed546a6ce887ce6027c2c268c0285f6efef0cdfc4366b23643790f67a86468ee8301ed12cfffcb07c6530f90a9327ec057800fabd332e4701").unwrap();
    let pk = env::ecrecover(&h, &sig[..64], sig[64], true).unwrap();
    assert_eq!(hex(&pk), "85a66984273f338ce4ef7b85e5430b008307e8591bb7c1b980852cf6423770b801f41e9438155eb53a5e20f748640093bb42ae3aeca035f7b7fd7a1a21f22f68");
    let rs: [u8; 64] = sig[..64].try_into().unwrap();
    let addr = eth_address_of(&pk);
    assert_eq!(recover_v(&h, &rs, 0, &addr), Some(1));
    // k256 round trip with our own key
    let k = key();
    let (s2, rid) = k.sign_prehash_recoverable(&h).unwrap();
    let rs2: [u8; 64] = s2.to_bytes().into();
    assert_eq!(recover_v(&h, &rs2, rid.to_byte() ^ 1, &addr_of(&k)), Some(rid.to_byte()));
}

// ---------- check_leg ----------

#[test]
fn accepts_a_good_leg() {
    let m = mandate("0x991543dd33bcf06563cd14a67decf1834fe6bf9b");
    assert_eq!(m.check_leg(&leg(1_000_000, 990_000, 1), NOW_MS), Ok(vec![(USDC.to_string(), 1_000_000)]));
}

#[test]
fn rejects_each_rule() {
    let m = mandate("0x991543dd33bcf06563cd14a67decf1834fe6bf9b");
    let e = |l: &Leg| m.check_leg(l, NOW_MS).unwrap_err();
    assert!(e(&leg(1_000_001, 999_000, 1)).contains("over per-leg max"));
    assert!(e(&leg(100_000, 98_999, 1)).contains("below min price"));
    assert!(e(&leg(0, 1, 1)).contains("zero amount"));
    let mut l = leg(100, 99, 1);
    l.give = BTC.into();
    assert!(e(&l).contains("token not allowed"));
    let mut l = leg(100, 99, 1);
    (l.give, l.get) = (USDT.into(), USDC.into());
    assert!(e(&l).contains("no price rule"));
    let mut l = leg(100, 99, 1);
    l.deadline_ms = NOW_MS - 1;
    assert!(e(&l).contains("past"));
    let mut l = leg(100, 99, 1);
    l.deadline_ms = NOW_MS + 2 * MAX_LEG_TTL_MS;
    l.nonce = nonce(SALT, l.deadline_ms, 1);
    assert!(e(&l).contains("1 hour"));
    let mut l = leg(100, 99, 1);
    l.salt = "00000000".into();
    assert!(e(&l).contains("nonce salt"));
    let mut l = leg(100, 99, 1);
    l.nonce = nonce(SALT, l.deadline_ms - 1, 1);
    assert!(e(&l).contains("nonce deadline before"));
    let mut l = leg(100, 99, 1);
    l.nonce.0[0] = 0;
    assert!(e(&l).contains("versioned"));
    assert!(m.check_leg(&leg(100, 99, 1), m.expires_at_ms).unwrap_err().contains("expired"));
    let mut short = m.clone();
    short.expires_at_ms = NOW_MS + 60_000;
    assert!(short.check_leg(&leg(100, 99, 1), NOW_MS).unwrap_err().contains("after mandate expiry"));
}

#[test]
fn tip_counts_toward_price_and_limits() {
    let m = mandate("0x991543dd33bcf06563cd14a67decf1834fe6bf9b");
    let mut l = leg(100_000, 99_000, 1);
    l.tip = Some(Tip { token: USDC.into(), amount: U128(1), receiver_id: acc("matcher.testnet") });
    // 99_000 / 100_001 < 0.99
    assert!(m.check_leg(&l, NOW_MS).unwrap_err().contains("below min price"));
    let mut l = leg(1_000_000, 999_000, 1);
    l.tip = Some(Tip { token: USDC.into(), amount: U128(1), receiver_id: acc("matcher.testnet") });
    assert!(m.check_leg(&l, NOW_MS).unwrap_err().contains("over per-leg max"));
    let mut l = leg(100_000, 99_500, 1);
    l.tip = Some(Tip { token: USDC.into(), amount: U128(10), receiver_id: acc("matcher.testnet") });
    assert_eq!(m.check_leg(&l, NOW_MS).unwrap(), vec![(USDC.to_string(), 100_010)]);
    // a tip in the get token would dodge the price check: refused
    l.tip = Some(Tip { token: USDT.into(), amount: U128(10), receiver_id: acc("matcher.testnet") });
    assert!(m.check_leg(&l, NOW_MS).unwrap_err().contains("tip must be in the give token"));
    l.tip = Some(Tip { token: BTC.into(), amount: U128(10), receiver_id: acc("matcher.testnet") });
    assert!(m.check_leg(&l, NOW_MS).unwrap_err().contains("tip must be in the give token"));
}

#[test]
fn daily_budget_accounting() {
    let mut m = mandate("0x991543dd33bcf06563cd14a67decf1834fe6bf9b");
    let day = NOW_MS / DAY_MS;
    let l = leg(1_000_000, 990_000, 1);
    for _ in 0..2 {
        let o = m.check_leg(&l, NOW_MS).unwrap();
        m.charge(&o, day);
    }
    assert_eq!(m.spent_today(USDC, day), 2_000_000);
    assert!(m.check_leg(&l, NOW_MS).unwrap_err().contains("over daily budget"));
    assert!(m.check_leg(&leg(500_000, 495_000, 1), NOW_MS).is_ok());
    // refund (failed signature) frees budget
    m.refund(&[(USDC.to_string(), 1_000_000)], day);
    assert_eq!(m.spent_today(USDC, day), 1_000_000);
    // next UTC day starts from zero and the old day is dropped on charge
    let tomorrow = NOW_MS + DAY_MS;
    let mut l2 = leg(1_000_000, 990_000, 2);
    l2.deadline_ms = tomorrow + 60_000;
    l2.nonce = nonce(SALT, l2.deadline_ms, 2);
    let o = m.check_leg(&l2, tomorrow).unwrap();
    m.charge(&o, day + 1);
    assert_eq!(m.spent_today(USDC, day + 1), 1_000_000);
    assert_eq!(m.spent.len(), 1);
}

// ---------- contract flow ----------

#[test]
fn set_mandate_needs_deposit_and_valid_args() {
    ctx("bob.testnet", NearToken::from_yoctonear(0), NOW_MS);
    let mut c = Contract::new(acc("intents.nomadswarm.testnet"), acc("v1.signer-prod.testnet"));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_mandate(args("0x991543dd33bcf06563cd14a67decf1834fe6bf9b"));
    }));
    assert!(r.is_err());
    ctx("bob.testnet", MANDATE_DEPOSIT, NOW_MS);
    let mut bad = args("0x991543dd33bcf06563cd14a67decf1834fe6bf9b");
    bad.prices[0].want = BTC.into();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_mandate(bad.clone());
    }))
    .is_err());
    let m = c.set_mandate(args("0x991543dd33bcf06563cd14a67decf1834fe6bf9b"));
    assert_eq!(m.path, "mandate/bob.testnet");
    assert_eq!(m.owner, acc("bob.testnet"));
}

#[test]
fn request_sign_callback_roundtrip() {
    let (mut c, k) = setup();
    ctx("proposer.testnet", LEG_DEPOSIT, NOW_MS + 1000);
    let _ = c.request_leg_signature(leg(1_000_000, 990_000, 1));
    assert_eq!(c.spent_today(acc("alice.testnet"), USDC.into()).0, 1_000_000);
    let v = c.signed_leg(0).unwrap();
    assert_eq!(v.status, LegStatus::Pending);
    assert!(v.multi_payload.is_none());

    let resp = mpc_response(&c, 0, &k, true); // wrong hint: the contract finds the right v
    ctx("mandate.testnet", NearToken::from_yoctonear(0), NOW_MS + 5000);
    let sig = c.on_signed(0, Ok(resp)).unwrap();
    let v = c.signed_leg(0).unwrap();
    assert_eq!(v.status, LegStatus::Signed);
    assert_eq!(v.signer_id, addr_of(&k));
    let mp = v.multi_payload.unwrap();
    assert_eq!(mp.standard, "erc191");
    assert_eq!(mp.signature, sig);
    let raw = bs58::decode(sig.strip_prefix("secp256k1:").unwrap()).into_vec().unwrap();
    assert_eq!(raw.len(), 65);
    assert!(raw[64] <= 1);
    let m = c.mandate(acc("alice.testnet")).unwrap();
    assert!(m.address_verified);
    assert_eq!(m.legs_signed, 1);
}

#[test]
fn nonce_reuse_and_budget_rejected() {
    let (mut c, _k) = setup();
    ctx("proposer.testnet", LEG_DEPOSIT, NOW_MS);
    let _ = c.request_leg_signature(leg(1_000_000, 990_000, 1));
    let reuse = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.request_leg_signature(leg(1_000, 990, 1));
    }));
    assert!(reuse.is_err());
    let _ = c.request_leg_signature(leg(1_000_000, 990_000, 2));
    assert_eq!(c.check_leg(leg(1_000_000, 990_000, 3)).unwrap(), format!("{} over daily budget: spent 2000000 + 1000000 > 2500000", USDC));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.request_leg_signature(leg(1_000_000, 990_000, 3));
    }))
    .is_err());
    ctx("proposer.testnet", NearToken::from_millinear(1), NOW_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.request_leg_signature(leg(1_000, 990, 4));
    }))
    .is_err());
}

#[test]
fn failed_or_foreign_signature_refunds_budget() {
    let (mut c, _k) = setup();
    ctx("proposer.testnet", LEG_DEPOSIT, NOW_MS);
    let _ = c.request_leg_signature(leg(1_000_000, 990_000, 1));
    let _ = c.request_leg_signature(leg(500_000, 495_000, 2));
    assert_eq!(c.spent_today(acc("alice.testnet"), USDC.into()).0, 1_500_000);

    // MPC timeout
    ctx("mandate.testnet", NearToken::from_yoctonear(0), NOW_MS + 1000);
    assert!(c.on_signed(0, Err(PromiseError::Failed)).is_none());
    assert_eq!(c.signed_leg(0).unwrap().status, LegStatus::Failed);
    assert_eq!(c.spent_today(acc("alice.testnet"), USDC.into()).0, 500_000);

    // a signature from another key (wrong eth_address) is never stored
    let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
    let resp = mpc_response(&c, 1, &other, false);
    assert!(c.on_signed(1, Ok(resp)).is_none());
    let v = c.signed_leg(1).unwrap();
    assert_eq!(v.status, LegStatus::Failed);
    assert!(v.error.unwrap().contains("does not recover"));
    assert_eq!(c.spent_today(acc("alice.testnet"), USDC.into()).0, 0);
    assert!(!c.mandate(acc("alice.testnet")).unwrap().address_verified);
}

#[test]
fn revoked_mandate_cannot_sign() {
    let (mut c, k) = setup();
    ctx("proposer.testnet", LEG_DEPOSIT, NOW_MS);
    let _ = c.request_leg_signature(leg(1_000, 990, 1));
    ctx("alice.testnet", NearToken::from_yoctonear(0), NOW_MS);
    c.revoke_mandate();
    let resp = mpc_response(&c, 0, &k, false);
    ctx("mandate.testnet", NearToken::from_yoctonear(0), NOW_MS + 1000);
    assert!(c.on_signed(0, Ok(resp)).is_none());
    assert_eq!(c.signed_leg(0).unwrap().status, LegStatus::Failed);
    ctx("proposer.testnet", LEG_DEPOSIT, NOW_MS);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.request_leg_signature(leg(1_000, 990, 2));
    }))
    .is_err());
}
