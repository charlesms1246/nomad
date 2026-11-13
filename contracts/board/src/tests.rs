use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

const T0: u64 = 1_700_000_000_000; // ms
const DEPOSIT: NearToken = NearToken::from_millinear(10);

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, deposit: NearToken, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("board.nomadswarm.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(3))
        .block_timestamp(now_ms * 1_000_000);
    testing_env!(b.build());
}

fn setup() -> Board {
    ctx("nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    let mut b = Board::new(acc("nomadswarm.testnet"), "ab".repeat(32), "RULES.md".into());
    b.add_matcher(acc("matcher.nomadswarm.testnet"));
    b
}

fn post(b: &mut Board, agent: &str, give: &str, want: &str, ttl: u64, now: u64) -> u64 {
    ctx(agent, DEPOSIT, now);
    b.post_offer(give.into(), U128(1000), want.into(), U128(3), U128(2), ttl)
}

/// Sum of NEAR transfers to `to` in the receipts created so far in this context.
fn transfers_to(to: &str) -> u128 {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(to))
        .flat_map(|r| r.actions)
        .map(|a| match a {
            MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .into_iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:").map(|s| serde_json::from_str::<Value>(s).unwrap()))
        .filter(|v| v["event"] == name)
        .collect()
}

#[test]
fn init_and_rules() {
    let b = setup();
    assert_eq!(b.rules(), RulesInfo { sha256: "ab".repeat(32), url: "RULES.md".into() });
    assert_eq!(b.owner(), acc("nomadswarm.testnet"));
    assert!(b.is_matcher(acc("matcher.nomadswarm.testnet")));
    assert_eq!(b.stats().stored_offers, 0);
}

#[test]
fn post_offer_stores_and_emits() {
    let mut b = setup();
    let id = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0);
    assert_eq!(id, 0);
    let o = b.get_offer(id).unwrap();
    assert_eq!(o.agent, acc("a01.nomadswarm.testnet"));
    assert_eq!(o.give_max, U128(1000));
    assert_eq!((o.rate_num, o.rate_den), (U128(3), U128(2)));
    assert_eq!(o.created_at_ms, T0);
    assert_eq!(o.expires_at_ms, T0 + 60_000);
    let ev = events("offer_posted");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "nomad-board");
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["data"][0]["id"], 0);
    assert_eq!(b.stats().total_posted, 1);
}

#[test]
fn storage_deposit_charged_and_excess_refunded() {
    let mut b = setup();
    let id = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0);
    let charged = b.offer_storage_deposit(id).unwrap().0;
    assert!(charged > 0, "some storage must be charged");
    assert!(charged < DEPOSIT.as_yoctonear(), "charge {} under the hint", charged);
    // Excess refunded to the agent in the same call.
    assert_eq!(transfers_to("a01.nomadswarm.testnet"), DEPOSIT.as_yoctonear() - charged);
    // Charge matches the bytes really used by the offer.
    let bytes = charged / env::storage_byte_cost().as_yoctonear();
    assert!(bytes > 100 && bytes < 1000, "bytes = {}", bytes);
}

#[test]
#[should_panic(expected = "insufficient storage deposit")]
fn insufficient_deposit_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(1), T0);
    b.post_offer("x".into(), U128(1), "y".into(), U128(1), U128(1), 1000);
}

#[test]
fn replace_same_pair() {
    let mut b = setup();
    let first = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0);
    let first_dep = b.offer_storage_deposit(first).unwrap().0;
    // Replacing with zero attached works: the old deposit covers the new offer.
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0 + 1);
    let second = b.post_offer("nep141:usdc".into(), U128(500), "nep141:wnear".into(), U128(5), U128(4), 30_000);
    assert_ne!(first, second);
    assert!(b.get_offer(first).is_none());
    let mine = b.offers_by_agent(acc("a01.nomadswarm.testnet"));
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].id, second);
    assert_eq!(mine[0].give_max, U128(500));
    let second_dep = b.offer_storage_deposit(second).unwrap().0;
    assert_eq!(transfers_to("a01.nomadswarm.testnet"), 0);
    assert_eq!(b.storage_balance_of(acc("a01.nomadswarm.testnet")).0, first_dep - second_dep);
    assert_eq!(events("offer_posted")[0]["data"][0]["replaced_id"], first);
    assert_eq!(b.stats().total_replaced, 1);
    assert_eq!(b.stats().stored_offers, 1);

    // A different pair (or the reverse direction) is a separate offer.
    post(&mut b, "a01.nomadswarm.testnet", "nep141:wnear", "nep141:usdc", 60_000, T0 + 2);
    // Another agent on the same pair is separate too.
    post(&mut b, "a02.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0 + 2);
    assert_eq!(b.offers_by_agent(acc("a01.nomadswarm.testnet")).len(), 2);
    assert_eq!(b.stats().stored_offers, 3);
}

#[test]
fn replace_and_cancel_release_all_storage() {
    // The mock resets storage_usage per context, so measure inside one context.
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", DEPOSIT, T0);
    let base = env::storage_usage();
    let id = b.post_offer("nep141:usdc".into(), U128(1), "nep141:wnear".into(), U128(1), U128(1), 1000);
    let after_first = env::storage_usage();
    assert_eq!(
        (after_first - base) as u128 * env::storage_byte_cost().as_yoctonear(),
        b.offer_storage_deposit(id).unwrap().0
    );
    let id2 = b.post_offer("nep141:usdc".into(), U128(1), "nep141:wnear".into(), U128(1), U128(1), 1000);
    // The only growth is the new prepaid-balance entry holding the old deposit.
    let entry = env::storage_usage() - after_first;
    assert!(entry < 100, "balance entry {} bytes", entry);
    b.cancel_offer(id2);
    assert_eq!(env::storage_usage(), base + entry, "cancel frees all offer storage");
}

#[test]
fn cancel_by_owner_refunds() {
    let mut b = setup();
    let id = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0);
    let dep = b.offer_storage_deposit(id).unwrap().0;
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0 + 10);
    b.cancel_offer(id);
    assert!(b.get_offer(id).is_none());
    assert!(b.offers_by_agent(acc("a01.nomadswarm.testnet")).is_empty());
    assert_eq!(transfers_to("a01.nomadswarm.testnet"), 0, "refund goes to the prepaid balance");
    assert_eq!(b.storage_balance_of(acc("a01.nomadswarm.testnet")).0, dep);
    let ev = events("offer_cancelled");
    assert_eq!(ev[0]["data"][0]["id"], id);
    assert_eq!(b.stats().total_cancelled, 1);
    // The pair slot is free again.
    let id2 = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0 + 20);
    assert!(b.get_offer(id2).is_some());
}

#[test]
#[should_panic(expected = "only the offer's agent can cancel it")]
fn cancel_by_other_rejected() {
    let mut b = setup();
    let id = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0);
    ctx("a02.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.cancel_offer(id);
}

#[test]
#[should_panic(expected = "only the offer's agent can cancel it")]
fn cancel_by_contract_owner_rejected() {
    let mut b = setup();
    let id = post(&mut b, "a01.nomadswarm.testnet", "nep141:usdc", "nep141:wnear", 60_000, T0);
    ctx("nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.cancel_offer(id);
}

#[test]
#[should_panic(expected = "offer not found")]
fn cancel_missing() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.cancel_offer(42);
}

#[test]
fn expiry_and_prune() {
    let mut b = setup();
    let a = post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:b", 1_000, T0);
    let c = post(&mut b, "a02.nomadswarm.testnet", "t:b", "t:c", 5_000, T0);
    let d = post(&mut b, "a03.nomadswarm.testnet", "t:c", "t:a", 3_000, T0);
    let dep_a = b.offer_storage_deposit(a).unwrap().0;
    let dep_d = b.offer_storage_deposit(d).unwrap().0;

    // Before expiry: all live.
    ctx("anyone.testnet", NearToken::from_yoctonear(0), T0 + 999);
    assert_eq!(b.offers(0, 10).len(), 3);
    assert_eq!(b.prune_expired(10), 0);

    // At T0+3000: a and d are expired (expires_at <= now) and hidden from views.
    ctx("anyone.testnet", NearToken::from_yoctonear(0), T0 + 3_000);
    let live: Vec<u64> = b.offers(0, 10).iter().map(|o| o.id).collect();
    assert_eq!(live, vec![c]);
    assert!(b.offers_by_agent(acc("a01.nomadswarm.testnet")).is_empty());
    assert!(b.get_offer(a).is_some(), "still stored until pruned");

    // Limit is respected: oldest expiry first.
    assert_eq!(b.prune_expired(1), 1);
    assert!(b.get_offer(a).is_none());
    assert!(b.get_offer(d).is_some());
    assert_eq!(b.storage_balance_of(acc("a01.nomadswarm.testnet")).0, dep_a);

    ctx("anyone.testnet", NearToken::from_yoctonear(0), T0 + 3_000);
    assert_eq!(b.prune_expired(10), 1);
    assert_eq!(b.storage_balance_of(acc("a03.nomadswarm.testnet")).0, dep_d);
    assert!(get_created_receipts().is_empty(), "prune makes no transfers");
    let ev = events("offer_expired");
    assert_eq!(ev[0]["data"][0]["id"], d);
    assert_eq!(ev[0]["data"][0]["pruned_by"], "anyone.testnet");
    assert!(b.get_offer(c).is_some());
    assert_eq!(b.stats().total_expired, 2);
    assert_eq!(b.prune_expired(10), 0);
}

#[test]
fn replacing_resets_expiry_index() {
    let mut b = setup();
    post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:b", 1_000, T0);
    let id2 = post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:b", 60_000, T0);
    ctx("anyone.testnet", NearToken::from_yoctonear(0), T0 + 2_000);
    assert_eq!(b.prune_expired(10), 0, "old expiry entry must be gone");
    assert_eq!(b.offers(0, 10)[0].id, id2);
}

#[test]
fn ttl_bound() {
    let mut b = setup();
    let id = post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:b", MAX_TTL_MS, T0);
    assert_eq!(b.get_offer(id).unwrap().expires_at_ms, T0 + 3_600_000);
}

#[test]
#[should_panic(expected = "ttl_ms must be <= 3600000")]
fn ttl_over_one_hour_rejected() {
    let mut b = setup();
    post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:b", MAX_TTL_MS + 1, T0);
}

#[test]
#[should_panic(expected = "ttl_ms must be > 0")]
fn ttl_zero_rejected() {
    let mut b = setup();
    post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:b", 0, T0);
}

#[test]
#[should_panic(expected = "give_max must be > 0")]
fn zero_give_max_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", DEPOSIT, T0);
    b.post_offer("t:a".into(), U128(0), "t:b".into(), U128(1), U128(1), 1000);
}

#[test]
#[should_panic(expected = "rate_num must be > 0")]
fn zero_rate_num_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", DEPOSIT, T0);
    b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(0), U128(1), 1000);
}

#[test]
#[should_panic(expected = "rate_den must be > 0")]
fn zero_rate_den_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", DEPOSIT, T0);
    b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(1), U128(0), 1000);
}

#[test]
#[should_panic(expected = "give and want must be different tokens")]
fn equal_tokens_rejected() {
    let mut b = setup();
    post(&mut b, "a01.nomadswarm.testnet", "t:a", "t:a", 1000, T0);
}

#[test]
#[should_panic(expected = "give and want must be non-empty")]
fn empty_token_rejected() {
    let mut b = setup();
    post(&mut b, "a01.nomadswarm.testnet", "", "t:a", 1000, T0);
}

#[test]
fn pagination() {
    let mut b = setup();
    for i in 0..7 {
        post(&mut b, &format!("a{:02}.nomadswarm.testnet", i), "t:a", "t:b", 60_000, T0);
    }
    ctx("anyone.testnet", NearToken::from_yoctonear(0), T0);
    let p1 = b.offers(0, 3);
    assert_eq!(p1.iter().map(|o| o.id).collect::<Vec<_>>(), vec![0, 1, 2]);
    let p2 = b.offers(p1.last().unwrap().id + 1, 3);
    assert_eq!(p2.iter().map(|o| o.id).collect::<Vec<_>>(), vec![3, 4, 5]);
    let p3 = b.offers(p2.last().unwrap().id + 1, 3);
    assert_eq!(p3.iter().map(|o| o.id).collect::<Vec<_>>(), vec![6]);
    assert!(b.offers(7, 3).is_empty());
    assert!(b.offers(0, 0).is_empty());

    // Gaps from cancellation are skipped.
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.cancel_offer(1);
    assert_eq!(b.offers(0, 3).iter().map(|o| o.id).collect::<Vec<_>>(), vec![0, 2, 3]);
    // Expired offers are skipped and don't count against the limit.
    let short = post(&mut b, "a09.nomadswarm.testnet", "t:a", "t:b", 10, T0);
    ctx("anyone.testnet", NearToken::from_yoctonear(0), T0 + 20);
    let all: Vec<u64> = b.offers(0, 100).iter().map(|o| o.id).collect();
    assert!(!all.contains(&short));
    assert_eq!(all.len(), 6);
}

#[test]
fn record_ring_by_matcher() {
    let mut b = setup();
    ctx("matcher.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.record_ring("r1".into(), vec![0, 1, 2], "TxHash1".into());
    let rings = b.rings(0, 10);
    assert_eq!(rings.len(), 1);
    assert_eq!(rings[0].seq, 0);
    assert_eq!(rings[0].ring_id, "r1");
    assert_eq!(rings[0].offer_ids, vec![0, 1, 2]);
    assert_eq!(rings[0].matcher, acc("matcher.nomadswarm.testnet"));
    let ev = events("ring_recorded");
    assert_eq!(ev[0]["data"][0]["tx_hash"], "TxHash1");
    assert_eq!(b.stats().total_rings, 1);
}

#[test]
#[should_panic(expected = "only registered matchers can record rings")]
fn record_ring_by_non_matcher_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.record_ring("r1".into(), vec![0, 1], "tx".into());
}

#[test]
#[should_panic(expected = "a ring has 2 to 5 offers")]
fn record_ring_too_long_rejected() {
    let mut b = setup();
    ctx("matcher.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.record_ring("r1".into(), vec![0, 1, 2, 3, 4, 5], "tx".into());
}

#[test]
fn ring_log_is_bounded() {
    let mut b = setup();
    for i in 0..(RING_LOG_CAP + 10) {
        if i % 50 == 0 {
            // fresh context: the mock caps total log length per call
            ctx("matcher.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
        }
        b.record_ring(format!("r{:04}", i), vec![0, 1], format!("tx{:04}", i));
    }
    assert_eq!(b.stats().total_rings, RING_LOG_CAP + 10);
    // Old entries are overwritten; from=0 starts at the oldest retained one.
    let page = b.rings(0, 5);
    assert_eq!(page.len(), 5);
    assert_eq!(page[0].seq, 10);
    assert_eq!(page[0].ring_id, "r0010");
    let tail = b.rings(RING_LOG_CAP + 8, 10);
    assert_eq!(tail.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![RING_LOG_CAP + 8, RING_LOG_CAP + 9]);
    assert_eq!(b.rings(0, 1000).len(), MAX_PAGE as usize);
    // Once full, recording overwrites a slot and storage does not grow.
    ctx("matcher.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    let before = env::storage_usage();
    b.record_ring("r9999".into(), vec![0, 1], "tx9999".into());
    assert_eq!(env::storage_usage(), before);
}

#[test]
fn matcher_admin() {
    let mut b = setup();
    ctx("nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    assert!(b.add_matcher(acc("intents-matcher.nomadswarm.testnet")));
    assert_eq!(b.matchers().len(), 2);
    assert!(b.remove_matcher(acc("matcher.nomadswarm.testnet")));
    assert!(!b.is_matcher(acc("matcher.nomadswarm.testnet")));
    b.set_rules("cd".repeat(32), "https://x/RULES.md".into());
    assert_eq!(b.rules().url, "https://x/RULES.md");
}

#[test]
#[should_panic(expected = "owner only")]
fn add_matcher_non_owner_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.add_matcher(acc("a01.nomadswarm.testnet"));
}

#[test]
#[should_panic(expected = "owner only")]
fn remove_matcher_non_owner_rejected() {
    let mut b = setup();
    ctx("matcher.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.remove_matcher(acc("matcher.nomadswarm.testnet"));
}

#[test]
#[should_panic(expected = "owner only")]
fn set_rules_non_owner_rejected() {
    let mut b = setup();
    ctx("a01.nomadswarm.testnet", NearToken::from_yoctonear(0), T0);
    b.set_rules("x".into(), "y".into());
}

// ---------------------------------------------------------------- prepaid storage

const A1: &str = "a01.nomadswarm.testnet";
const ZERO: NearToken = NearToken::from_yoctonear(0);

#[test]
fn storage_deposit_and_balance_of() {
    let mut b = setup();
    ctx(A1, NearToken::from_millinear(50), T0);
    assert_eq!(b.storage_deposit(None).0, NearToken::from_millinear(50).as_yoctonear());
    // Deposit on behalf of another account.
    ctx("funder.testnet", NearToken::from_millinear(20), T0);
    b.storage_deposit(Some(acc(A1)));
    assert_eq!(b.storage_balance_of(acc(A1)).0, NearToken::from_millinear(70).as_yoctonear());
    assert_eq!(b.storage_balance_of(acc("funder.testnet")).0, 0);
}

#[test]
#[should_panic(expected = "storage_deposit requires at least 0.001 NEAR")]
fn storage_deposit_too_small() {
    let mut b = setup();
    ctx(A1, NearToken::from_yoctonear(1), T0);
    b.storage_deposit(None);
}

#[test]
fn post_with_zero_attached_uses_prepaid_balance() {
    let mut b = setup();
    let prepaid = NearToken::from_millinear(20).as_yoctonear();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    ctx(A1, ZERO, T0);
    let id = b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(1), U128(1), 1000);
    let dep = b.offer_storage_deposit(id).unwrap().0;
    assert_eq!(b.storage_balance_of(acc(A1)).0, prepaid - dep);
    assert!(get_created_receipts().is_empty(), "no transfer when nothing attached");
    // Cancel puts the deposit back into the balance.
    b.cancel_offer(id);
    assert_eq!(b.storage_balance_of(acc(A1)).0, prepaid);
}

#[test]
fn attached_used_before_prepaid_balance() {
    let mut b = setup();
    let prepaid = NearToken::from_millinear(20).as_yoctonear();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    let id = post(&mut b, A1, "t:a", "t:b", 1000, T0);
    let dep = b.offer_storage_deposit(id).unwrap().0;
    assert_eq!(b.storage_balance_of(acc(A1)).0, prepaid, "balance untouched");
    assert_eq!(transfers_to(A1), DEPOSIT.as_yoctonear() - dep);
}

#[test]
fn partial_attached_topped_up_from_balance() {
    let mut b = setup();
    let prepaid = NearToken::from_millinear(20).as_yoctonear();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    let small = 1_000_000_000_000_000_000_000u128; // 0.001 NEAR, less than one offer
    ctx(A1, NearToken::from_yoctonear(small), T0);
    let id = b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(1), U128(1), 1000);
    let dep = b.offer_storage_deposit(id).unwrap().0;
    assert!(dep > small);
    assert_eq!(b.storage_balance_of(acc(A1)).0, prepaid - (dep - small));
    assert_eq!(transfers_to(A1), 0);
}

#[test]
#[should_panic(expected = "insufficient storage deposit")]
fn zero_attached_without_balance_rejected() {
    let mut b = setup();
    ctx(A1, ZERO, T0);
    b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(1), U128(1), 1000);
}

#[test]
fn replace_with_zero_attached_keeps_balance_consistent() {
    let mut b = setup();
    let prepaid = NearToken::from_millinear(20).as_yoctonear();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    ctx(A1, ZERO, T0);
    let id1 = b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(1), U128(1), 1000);
    let id2 = b.post_offer("t:a".into(), U128(2), "t:b".into(), U128(1), U128(1), 1000);
    let dep2 = b.offer_storage_deposit(id2).unwrap().0;
    assert!(b.get_offer(id1).is_none());
    assert_eq!(b.storage_balance_of(acc(A1)).0, prepaid - dep2);
}

#[test]
fn prune_credits_prepaid_balance() {
    let mut b = setup();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    ctx(A1, ZERO, T0);
    b.post_offer("t:a".into(), U128(1), "t:b".into(), U128(1), U128(1), 10);
    ctx("anyone.testnet", ZERO, T0 + 100);
    assert_eq!(b.prune_expired(5), 1);
    assert_eq!(b.storage_balance_of(acc(A1)).0, NearToken::from_millinear(20).as_yoctonear());
    assert!(get_created_receipts().is_empty());
}

#[test]
fn storage_withdraw_partial_and_full() {
    let mut b = setup();
    let prepaid = NearToken::from_millinear(20).as_yoctonear();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    ctx(A1, NearToken::from_yoctonear(1), T0);
    assert_eq!(b.storage_withdraw(Some(U128(5))).0, prepaid - 5);
    assert_eq!(transfers_to(A1), 5 + 1);
    ctx(A1, NearToken::from_yoctonear(1), T0);
    assert_eq!(b.storage_withdraw(None).0, 0);
    assert_eq!(transfers_to(A1), prepaid - 5 + 1);
    assert_eq!(b.storage_balance_of(acc(A1)).0, 0);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn storage_withdraw_needs_one_yocto() {
    let mut b = setup();
    ctx(A1, NearToken::from_millinear(20), T0);
    b.storage_deposit(None);
    ctx(A1, ZERO, T0);
    b.storage_withdraw(None);
}

#[test]
#[should_panic(expected = "amount exceeds storage balance")]
fn storage_withdraw_over_balance() {
    let mut b = setup();
    ctx(A1, NearToken::from_yoctonear(1), T0);
    b.storage_withdraw(Some(U128(1)));
}
