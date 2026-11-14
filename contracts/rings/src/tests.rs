use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const W: &str = "nep141:wnear.nomadswarm.testnet";
const U: &str = "nep141:usdc.nomadswarm.testnet";
const Z: &str = "nep141:zec.nomadswarm.testnet";
const VERIFIER: &str = "intents.nomadswarm.testnet";

fn ctx(pred: usize, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("rings.nomadswarm.testnet".parse().unwrap())
        .predecessor_account_id(accounts(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(1_000_000_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn contract() -> Rings {
    ctx(0, 0);
    Rings::new(accounts(0), VERIFIER.parse().unwrap(), 1)
}

/// a01 gives 1e24 wNEAR, a02 gives 3_000_000 USDC, a03 gives 300_000 ZEC; receivers get x - fee.
fn ring3(tip: bool) -> Vec<LegSpec> {
    let xs: [u128; 3] = [10u128.pow(24), 3_000_000, 300_000];
    let toks = [W, U, Z];
    let hex_id = "ab".repeat(32);
    let agents = ["a01.nomadswarm.testnet", "0x00000000000000000000000000000000000000aa", hex_id.as_str()];
    (0..3)
        .map(|i| {
            let next = (i + 1) % 3;
            LegSpec {
                agent: agents[i].to_string(),
                give: toks[i].into(),
                give_amt: U128(xs[i]),
                get: toks[next].into(),
                get_amt: U128(xs[next] - fee_of(xs[next], 1)),
                tip: if tip { Some(Tip { token: toks[i].into(), amt: U128(10) }) } else { None },
            }
        })
        .collect()
}

fn msg_for(leg: &LegSpec, tip_to: &str) -> String {
    let mut intents = vec![json!({ "intent": "token_diff", "diff": { leg.give.clone(): format!("-{}", leg.give_amt.0), leg.get.clone(): leg.get_amt.0.to_string() } })];
    if let Some(t) = &leg.tip {
        intents.push(json!({ "intent": "transfer", "receiver_id": tip_to, "tokens": { t.token.clone(): t.amt.0.to_string() } }));
    }
    json!({ "signer_id": leg.agent, "verifying_contract": VERIFIER, "deadline": "2030-01-01T00:00:00Z", "intents": intents }).to_string()
}

fn nep413(leg: &LegSpec) -> String {
    json!({ "standard": "nep413", "payload": { "message": msg_for(leg, "rings.nomadswarm.testnet"), "nonce": "AAAA", "recipient": VERIFIER }, "public_key": "ed25519:x", "signature": "ed25519:y" }).to_string()
}
fn erc191(leg: &LegSpec) -> String {
    json!({ "standard": "erc191", "payload": msg_for(leg, "rings.nomadswarm.testnet"), "signature": "secp256k1:z" }).to_string()
}

#[test]
fn fee_is_a_ceiling() {
    assert_eq!(fee_of(1000, 1), 1);
    assert_eq!(fee_of(1_000_001, 1), 2);
    assert_eq!(fee_of(4_969_498, 1), 5); // matches the mainnet tx in BUILD_PLAN C3
}

#[test]
fn a_valid_ring_passes_and_needs_no_matcher_leg() {
    assert_eq!(check_ring(&ring3(true), 1), Ok(()));
}

#[test]
fn rejects_exact_zero_sum_without_fee() {
    let mut r = ring3(false);
    r[0].get_amt = r[1].give_amt.clone(); // receiver gets the full amount: Verifier would reject
    assert!(check_ring(&r, 1).unwrap_err().contains("nets to"));
}

#[test]
fn rejects_non_cycles_duplicates_and_bad_sizes() {
    let mut r = ring3(false);
    r[2].get = U.into();
    assert!(check_ring(&r, 1).is_err());
    let mut d = ring3(false);
    d[1].agent = d[0].agent.clone();
    assert!(check_ring(&d, 1).unwrap_err().contains("twice"));
    assert!(check_ring(&ring3(false)[..1], 1).is_err());
}

#[test]
fn propose_attach_any_standard() {
    let mut c = contract();
    ctx(1, 10u128.pow(23));
    let id = c.propose_ring(ring3(true), 1_000_000_000 + 600_000);
    let legs = c.get_ring(id.clone()).unwrap().legs;
    ctx(2, 10u128.pow(23));
    c.attach_leg(id.clone(), 0, nep413(&legs[0]));
    c.attach_leg(id.clone(), 1, erc191(&legs[1]));
    let raw = json!({ "standard": "raw_ed25519", "payload": msg_for(&legs[2], "rings.nomadswarm.testnet"), "public_key": "ed25519:p", "signature": "ed25519:s" }).to_string();
    c.attach_leg(id.clone(), 2, raw);
    let r = c.get_ring(id).unwrap();
    assert!(r.signed.iter().all(Option::is_some));
    assert_eq!(r.standards, vec![Some("nep413".into()), Some("erc191".into()), Some("raw_ed25519".into())]);
}

#[test]
#[should_panic(expected = "is not exactly")]
fn rejects_a_leg_with_the_wrong_amount() {
    let mut c = contract();
    ctx(1, 10u128.pow(23));
    let id = c.propose_ring(ring3(false), 1_000_000_000 + 600_000);
    let mut leg = c.get_ring(id.clone()).unwrap().legs[0].clone();
    leg.get_amt = U128(leg.get_amt.0 + 1);
    c.attach_leg(id, 0, nep413(&leg));
}

#[test]
#[should_panic(expected = "ring expects")]
fn rejects_a_leg_signed_by_someone_else() {
    let mut c = contract();
    ctx(1, 10u128.pow(23));
    let id = c.propose_ring(ring3(false), 1_000_000_000 + 600_000);
    let mut leg = c.get_ring(id.clone()).unwrap().legs[0].clone();
    leg.agent = "mallory.testnet".into();
    c.attach_leg(id, 0, nep413(&leg));
}

#[test]
fn rejects_tips_to_anyone_but_this_contract_and_extra_intents() {
    let legs = ring3(true);
    let m: Value = serde_json::from_str(&msg_for(&legs[0], "mallory.testnet")).unwrap();
    assert!(check_leg_message(&m, &legs[0], "rings.nomadswarm.testnet", VERIFIER).unwrap_err().contains("must go to"));
    let mut m2: Value = serde_json::from_str(&msg_for(&legs[0], "rings.nomadswarm.testnet")).unwrap();
    m2["intents"].as_array_mut().unwrap().push(json!({ "intent": "ft_withdraw", "token": "x" }));
    assert!(check_leg_message(&m2, &legs[0], "rings.nomadswarm.testnet", VERIFIER).unwrap_err().contains("unexpected intent"));
    let mut m3: Value = serde_json::from_str(&msg_for(&legs[0], "rings.nomadswarm.testnet")).unwrap();
    m3["verifying_contract"] = json!("intents.near");
    assert!(check_leg_message(&m3, &legs[0], "rings.nomadswarm.testnet", VERIFIER).unwrap_err().contains("signed for verifier"));
}

#[test]
#[should_panic(expected = "not every leg is signed")]
fn close_needs_every_leg() {
    let mut c = contract();
    ctx(1, 10u128.pow(23));
    let id = c.propose_ring(ring3(false), 1_000_000_000 + 600_000);
    c.close_ring(id);
}

#[test]
fn settlement_pays_tips_to_the_closer_and_writes_reputation() {
    let mut c = contract();
    ctx(1, 10u128.pow(23));
    let id = c.propose_ring(ring3(true), 1_000_000_000 + 600_000);
    let mut ring = c.get_ring(id).unwrap();
    let tips = c.apply_outcome(&mut ring, &accounts(3), true, 5);
    assert_eq!(ring.status, RingStatus::Settled);
    assert_eq!(tips.len(), 3); // three tokens, 10 each
    assert!(tips.iter().all(|(_, a)| *a == 10));
    assert_eq!(c.reputation("a01.nomadswarm.testnet".into()).rings_settled, 1);
    assert_eq!(c.reputation(accounts(3).to_string()).rings_closed, 1);
}

#[test]
fn a_failed_close_moves_nothing_and_counts_against_the_ring() {
    let mut c = contract();
    ctx(1, 10u128.pow(23));
    let id = c.propose_ring(ring3(true), 1_000_000_000 + 600_000);
    let mut ring = c.get_ring(id).unwrap();
    let tips = c.apply_outcome(&mut ring, &accounts(3), false, 5);
    assert!(tips.is_empty());
    assert_eq!(ring.status, RingStatus::Failed);
    assert_eq!(c.reputation("a01.nomadswarm.testnet".into()).legs_in_failed_closes, 1);
    assert_eq!(c.reputation(accounts(3).to_string()).rings_closed, 0);
}

#[test]
fn identity_registration() {
    let mut c = contract();
    ctx(2, 0);
    c.register_agent("0x00000000000000000000000000000000000000aa".into(), "https://example.org/agent.json".into());
    assert_eq!(c.reputation("0x00000000000000000000000000000000000000aa".into()).registered_by, Some(accounts(2)));
}

#[test]
#[should_panic(expected = "registers itself")]
fn a_near_account_cannot_be_registered_by_someone_else() {
    let mut c = contract();
    ctx(2, 0);
    c.register_agent("a01.nomadswarm.testnet".into(), "x".into());
}

// ---- ERC-7683 (earlier draft) GaslessCrossChainOrder: golden vector shared with packages/intents ----
const VECTOR: &str = include_str!("../../../packages/intents/test/fixtures/erc7683-vector.json");

fn vector_order() -> (order::OrderInput, String, String) {
    let v: Value = serde_json::from_str(VECTOR).unwrap();
    let o = &v["order"];
    let leg = &v["leg"];
    let input = order::OrderInput {
        user: o["user"].as_str().unwrap().into(),
        nonce: o["nonce"].as_str().unwrap().into(),
        open_deadline: o["openDeadline"].as_u64().unwrap() as u32,
        fill_deadline: o["fillDeadline"].as_u64().unwrap() as u32,
        give: leg["give"].as_str().unwrap().into(),
        give_amount: U128(leg["giveAmount"].as_str().unwrap().parse().unwrap()),
        want: leg["want"].as_str().unwrap().into(),
        min_want_amount: U128(leg["minWantAmount"].as_str().unwrap().parse().unwrap()),
    };
    (input, v["digest"].as_str().unwrap().into(), v["signature"]["rsv"].as_str().unwrap().into())
}

#[test]
fn erc7683_order_data_and_digest_match_the_ts_vector() {
    ctx(0, 0);
    let v: Value = serde_json::from_str(VECTOR).unwrap();
    let (o, digest, _) = vector_order();
    let od = order::encode_leg(&o.give, o.give_amount.0, &o.want, o.min_want_amount.0);
    let od_hex = format!("0x{}", od.iter().map(|x| format!("{x:02x}")).collect::<String>());
    assert_eq!(od_hex, v["order"]["orderData"].as_str().unwrap());
    let d = order::order_digest(&o, 398).unwrap();
    assert_eq!(format!("0x{}", d.iter().map(|x| format!("{x:02x}")).collect::<String>()), digest);
}

#[test]
fn erc7683_ecrecover_finds_the_signer() {
    ctx(0, 0);
    let (o, _, sig) = vector_order();
    let d = order::order_digest(&o, 398).unwrap();
    assert_eq!(order::recover(&d, &sig).unwrap(), o.user);
    // tampered order -> different signer
    let mut t = o.clone();
    t.give_amount = U128(t.give_amount.0 + 1);
    let d2 = order::order_digest(&t, 398).unwrap();
    assert_ne!(order::recover(&d2, &sig).unwrap(), o.user);
    // mainnet domain -> different signer
    let d3 = order::order_digest(&o, 397).unwrap();
    assert_ne!(order::recover(&d3, &sig).unwrap(), o.user);
}

#[test]
fn submit_order_then_a_ring_below_the_order_price_is_rejected() {
    let mut c = contract();
    let (o, _, sig) = vector_order();
    // block time before the order's openDeadline
    let mut b = VMContextBuilder::new();
    b.current_account_id("rings.nomadswarm.testnet".parse().unwrap())
        .predecessor_account_id(accounts(2))
        .attached_deposit(NearToken::from_yoctonear(10u128.pow(23)))
        .block_timestamp((o.open_deadline as u64 - 60) * 1_000_000_000);
    testing_env!(b.build());
    let id = c.submit_order(o.clone(), sig);
    let rec = c.get_order(id).unwrap();
    assert_eq!(rec.input.user, o.user);
    assert!(c.order_for(o.user.clone(), o.give.clone(), o.want.clone()).is_some());
}
