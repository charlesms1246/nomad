//! near-workspaces integration test: deploys the built wasm to a local sandbox.
//! Build first: `cargo near build non-reproducible-wasm`.
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const WASM: &str = "target/near/nomad_board.wasm";

#[tokio::test]
async fn sandbox_flow() -> anyhow::Result<()> {
    let wasm = std::fs::read(WASM).expect("run `cargo near build non-reproducible-wasm` first");
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let matcher = worker.dev_create_account().await?;
    let a1 = worker.dev_create_account().await?;
    let a2 = worker.dev_create_account().await?;
    let board = worker.dev_deploy(&wasm).await?;

    board
        .call("new")
        .args_json(json!({"owner_id": owner.id(), "rules_sha256": "ab", "rules_url": "RULES.md"}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(board.id(), "add_matcher")
        .args_json(json!({"account_id": matcher.id()}))
        .transact()
        .await?
        .into_result()?;

    let post = |acct: near_workspaces::Account, give: &'static str, want: &'static str, ttl: u64| {
        let board_id = board.id().clone();
        async move {
            acct.call(&board_id, "post_offer")
                .args_json(json!({"give": give, "give_max": "1000", "want": want,
                                  "rate_num": "1", "rate_den": "1", "ttl_ms": ttl}))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await
        }
    };

    let r = post(a1.clone(), "t:a", "t:b", 600_000).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(r.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("offer_posted")));
    let id0: u64 = r.json()?;
    // Replace.
    let id1: u64 = post(a1.clone(), "t:a", "t:b", 600_000).await?.json()?;
    assert_ne!(id0, id1);
    post(a2.clone(), "t:b", "t:a", 600_000).await?.into_result()?;

    // Bad TTL and equal tokens fail.
    assert!(post(a1.clone(), "t:a", "t:c", 3_600_001).await?.is_failure());
    assert!(post(a1.clone(), "t:a", "t:a", 1_000).await?.is_failure());

    let offers: Vec<Value> = board.view("offers").args_json(json!({"from": 0, "limit": 10})).await?.json()?;
    assert_eq!(offers.len(), 2);

    // Only the owner cancels; cancel refunds.
    let r = a2.call(board.id(), "cancel_offer").args_json(json!({"id": id1})).transact().await?;
    assert!(r.is_failure());
    a1.call(board.id(), "cancel_offer").args_json(json!({"id": id1})).transact().await?.into_result()?;

    // Only matchers record rings.
    let args = json!({"ring_id": "r1", "offer_ids": [id0, id1], "tx_hash": "h"});
    assert!(a1.call(board.id(), "record_ring").args_json(args.clone()).transact().await?.is_failure());
    matcher.call(board.id(), "record_ring").args_json(args).transact().await?.into_result()?;
    let rings: Vec<Value> = board.view("rings").args_json(json!({"from": 0, "limit": 10})).await?.json()?;
    assert_eq!(rings.len(), 1);

    // Expiry + prune.
    post(a1.clone(), "t:x", "t:y", 1).await?.into_result()?;
    worker.fast_forward(5).await?;
    let pruned: u32 = a2.call(board.id(), "prune_expired").args_json(json!({"limit": 10}))
        .transact().await?.json()?;
    assert_eq!(pruned, 1);

    // Prepaid storage: post with 0 attached (what a function-call key does).
    a2.call(board.id(), "storage_deposit").args_json(json!({}))
        .deposit(NearToken::from_millinear(50)).transact().await?.into_result()?;
    let r = a2.call(board.id(), "post_offer")
        .args_json(json!({"give": "t:q", "give_max": "5", "want": "t:r",
                          "rate_num": "1", "rate_den": "1", "ttl_ms": 600_000}))
        .transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let bal: String = board.view("storage_balance_of").args_json(json!({"account_id": a2.id()})).await?.json()?;
    assert!(bal.parse::<u128>()? < NearToken::from_millinear(50).as_yoctonear());
    // Withdraw needs 1 yocto.
    assert!(a2.call(board.id(), "storage_withdraw").args_json(json!({})).transact().await?.is_failure());
    a2.call(board.id(), "storage_withdraw").args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;

    let stats: Value = board.view("stats").await?.json()?;
    assert_eq!(stats["stored_offers"], 2);
    Ok(())
}
