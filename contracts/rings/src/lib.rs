//! Nomad v2 — permissionless on-chain ring closing for NEAR Intents.
//!
//! A *ring* is a cycle of 2..=5 legs: leg i gives `give_amt` of `give` and receives `get_amt` of
//! `get`, and `get` of leg i is `give` of leg i+1. It settles in ONE `execute_intents` call on the
//! Verifier, so every leg executes or none does.
//!
//! Flow (no allowlisted matcher, no fixed cut):
//! 1. `propose_ring(legs, deadline_ms)`: anyone. The contract checks the cycle and that every token
//!    nets to zero after the Verifier fee (receiver gets x - ceil(x * fee_pips / 1e6)), so there is
//!    no matcher leg: all surplus stays with the agents.
//! 2. `attach_leg(ring_id, index, signed)`: anyone may relay an agent's signed leg (any wallet
//!    standard the Verifier accepts: nep413, erc191, raw_ed25519, webauthn). The contract parses the
//!    signed message and requires that it says exactly what the ring needs from that agent: the
//!    signer, one `token_diff` with exactly {give: -give_amt, get: +get_amt}, and (if the leg pays a
//!    tip) one `transfer` of the tip to THIS contract's Verifier account. Signatures themselves are
//!    checked by the Verifier, which is the authority.
//! 3. `close_ring(ring_id)`: anyone, once all legs are attached. Cross-contract `execute_intents`;
//!    on success the callback pays the tips to the closer with `mt_transfer` (the contract acts on
//!    its own Verifier account by predecessor auth) and updates reputation.
//!
//! Reputation (an ERC-8004-style registry, ported): `register_agent` stores an identity record
//! (agent id -> uri, registered by); `close_ring` writes outcomes automatically: rings settled per
//! agent, rings closed per closer, failed closes per ring.

pub mod order;
use order::{Order, OrderInput};
use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const EVENT_STANDARD: &str = "nomad-rings";
const EVENT_VERSION: &str = "1.0.0";
const MAX_LEGS: usize = 5;
const MAX_DEADLINE_AHEAD_MS: u64 = 3_600_000;
const PIPS: u128 = 1_000_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Rings,
    RingIds,
    Rep,
    Orders,
    OrderByKey,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tip {
    pub token: String,
    pub amt: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct LegSpec {
    /// The leg's signer_id in the Verifier: a NEAR account, a 64-hex implicit id, or a 0x address.
    pub agent: String,
    pub give: String,
    pub give_amt: U128,
    pub get: String,
    pub get_amt: U128,
    pub tip: Option<Tip>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum RingStatus {
    Open,
    Closing,
    Settled,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Ring {
    pub id: String,
    pub proposer: AccountId,
    pub legs: Vec<LegSpec>,
    pub deadline_ms: u64,
    /// The signed MultiPayload JSON for each leg, once attached.
    pub signed: Vec<Option<String>>,
    /// The standard of each attached leg ("nep413", "erc191", ...).
    pub standards: Vec<Option<String>>,
    pub status: RingStatus,
    pub closer: Option<AccountId>,
    pub close_attempts: u32,
    pub created_ms: u64,
    pub settled_ms: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reputation {
    /// ERC-8004-style identity record (optional).
    pub agent_uri: Option<String>,
    pub registered_by: Option<AccountId>,
    /// Outcomes written by the contract only.
    pub rings_settled: u64,
    pub rings_closed: u64,
    pub legs_in_failed_closes: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Rings {
    owner: AccountId,
    verifier: AccountId,
    fee_pips: u32,
    rings: LookupMap<String, Ring>,
    ring_ids: Vector<String>,
    rep: LookupMap<String, Reputation>,
    total_settled: u64,
    /// ERC-7683 orders (id -> order) and the live order for (user|give|want).
    orders: LookupMap<String, Order>,
    order_by_key: LookupMap<String, String>,
    /// EIP-155 chain id in the EIP-712 domain: 398 NEAR testnet, 397 NEAR mainnet.
    chain_id: u64,
}

/// State layout before ERC-7683 orders were added (for `migrate`).
#[near(serializers = [borsh])]
pub struct RingsV1 {
    owner: AccountId,
    verifier: AccountId,
    fee_pips: u32,
    rings: LookupMap<String, Ring>,
    ring_ids: Vector<String>,
    rep: LookupMap<String, Reputation>,
    total_settled: u64,
}

fn order_key(user: &str, give: &str, want: &str) -> String {
    format!("{}|{}|{}", user.to_ascii_lowercase(), give, want)
}

pub fn fee_of(x: u128, fee_pips: u32) -> u128 {
    (x * fee_pips as u128 + PIPS - 1) / PIPS
}

fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&ev).unwrap()));
}

/// Validates a ring's shape: 2..=5 legs from distinct agents, a closed cycle, positive amounts, and
/// per-token zero-sum after the Verifier fee with no extra leg.
pub fn check_ring(legs: &[LegSpec], fee_pips: u32) -> Result<(), String> {
    let k = legs.len();
    if !(2..=MAX_LEGS).contains(&k) {
        return Err(format!("ring needs 2..={MAX_LEGS} legs, got {k}"));
    }
    for (i, l) in legs.iter().enumerate() {
        if l.agent.is_empty() || l.give.is_empty() || l.get.is_empty() {
            return Err(format!("leg {i}: empty field"));
        }
        if l.give == l.get {
            return Err(format!("leg {i}: give and get are the same token"));
        }
        if l.give_amt.0 == 0 || l.get_amt.0 == 0 {
            return Err(format!("leg {i}: zero amount"));
        }
        if let Some(t) = &l.tip {
            if t.amt.0 == 0 || t.token.is_empty() {
                return Err(format!("leg {i}: empty tip"));
            }
        }
        if legs.iter().filter(|o| o.agent == l.agent).count() > 1 {
            return Err(format!("agent {} appears twice", l.agent));
        }
        let next = &legs[(i + 1) % k];
        if l.get != next.give {
            return Err(format!("leg {i}: gets {} but leg {} gives {}", l.get, (i + 1) % k, next.give));
        }
        let expect = next.give_amt.0 - fee_of(next.give_amt.0, fee_pips);
        if l.get_amt.0 != expect {
            return Err(format!(
                "leg {i}: gets {} of {} but the next leg's give nets to {} after the Verifier fee",
                l.get_amt.0, l.get, expect
            ));
        }
    }
    Ok(())
}

/// Extracts (standard, message JSON) from a signed MultiPayload.
pub fn parse_signed(signed: &str) -> Result<(String, Value), String> {
    let v: Value = serde_json::from_str(signed).map_err(|e| format!("signed leg is not JSON: {e}"))?;
    let standard = v.get("standard").and_then(Value::as_str).ok_or("missing standard")?.to_string();
    let msg_str = match standard.as_str() {
        "nep413" => v.get("payload").and_then(|p| p.get("message")).and_then(Value::as_str),
        "erc191" | "raw_ed25519" | "webauthn" | "tip191" | "sep53" => v.get("payload").and_then(Value::as_str),
        other => return Err(format!("unsupported standard {other}")),
    }
    .ok_or("missing signed message")?;
    let msg: Value = serde_json::from_str(msg_str).map_err(|e| format!("signed message is not JSON: {e}"))?;
    Ok((standard, msg))
}

/// Checks that a signed message commits to exactly this leg: the signer, one token_diff with exactly
/// {give: -give_amt, get: +get_amt}, and the tip (if any) as one transfer to `tip_receiver`.
pub fn check_leg_message(msg: &Value, leg: &LegSpec, tip_receiver: &str, verifier: &str) -> Result<(), String> {
    let signer = msg.get("signer_id").and_then(Value::as_str).ok_or("message has no signer_id")?;
    if !signer.eq_ignore_ascii_case(&leg.agent) {
        return Err(format!("signed by {signer}, ring expects {}", leg.agent));
    }
    if let Some(vc) = msg.get("verifying_contract").and_then(Value::as_str) {
        if vc != verifier {
            return Err(format!("signed for verifier {vc}, ring settles on {verifier}"));
        }
    }
    let intents = msg.get("intents").and_then(Value::as_array).ok_or("message has no intents")?;
    let mut diffs = 0;
    let mut transfers = 0;
    for it in intents {
        match it.get("intent").and_then(Value::as_str) {
            Some("token_diff") => {
                diffs += 1;
                let d = it.get("diff").and_then(Value::as_object).ok_or("token_diff has no diff")?;
                let want_give = format!("-{}", leg.give_amt.0);
                let want_get = leg.get_amt.0.to_string();
                let ok = d.len() == 2
                    && d.get(&leg.give).and_then(Value::as_str) == Some(want_give.as_str())
                    && d.get(&leg.get).and_then(Value::as_str) == Some(want_get.as_str());
                if !ok {
                    return Err(format!("token_diff {} is not exactly {{{}: {}, {}: {}}}", Value::Object(d.clone()), leg.give, want_give, leg.get, want_get));
                }
            }
            Some("transfer") => {
                transfers += 1;
                let tip = leg.tip.as_ref().ok_or("leg pays no tip but the message has a transfer")?;
                let to = it.get("receiver_id").and_then(Value::as_str).ok_or("transfer has no receiver_id")?;
                if to != tip_receiver {
                    return Err(format!("tip goes to {to}, must go to {tip_receiver}"));
                }
                let toks = it.get("tokens").and_then(Value::as_object).ok_or("transfer has no tokens")?;
                let amt = tip.amt.0.to_string();
                if toks.len() != 1 || toks.get(&tip.token).and_then(Value::as_str) != Some(amt.as_str()) {
                    return Err(format!("tip transfer is not exactly {{{}: {}}}", tip.token, amt));
                }
            }
            other => return Err(format!("unexpected intent {:?} in leg", other)),
        }
    }
    if diffs != 1 {
        return Err(format!("expected exactly one token_diff, found {diffs}"));
    }
    if transfers != usize::from(leg.tip.is_some()) {
        return Err("tip transfer missing or duplicated".into());
    }
    Ok(())
}

#[near]
impl Rings {
    #[init]
    pub fn new(owner_id: AccountId, verifier_id: AccountId, fee_pips: u32) -> Self {
        Self {
            owner: owner_id,
            verifier: verifier_id,
            fee_pips,
            rings: LookupMap::new(Key::Rings),
            ring_ids: Vector::new(Key::RingIds),
            rep: LookupMap::new(Key::Rep),
            total_settled: 0,
            orders: LookupMap::new(Key::Orders),
            order_by_key: LookupMap::new(Key::OrderByKey),
            chain_id: 398,
        }
    }

    /// One-time state upgrade from the layout without orders. Owner only.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let old: RingsV1 = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
        Self {
            owner: old.owner,
            verifier: old.verifier,
            fee_pips: old.fee_pips,
            rings: old.rings,
            ring_ids: old.ring_ids,
            rep: old.rep,
            total_settled: old.total_settled,
            orders: LookupMap::new(Key::Orders),
            order_by_key: LookupMap::new(Key::OrderByKey),
            chain_id: 398,
        }
    }

    /// ERC-7683 ingress: anyone relays a `GaslessCrossChainOrder` signed (EIP-712) by an EVM wallet.
    /// The contract recomputes the digest, recovers the signer and records the order as that 0x
    /// address's standing limit for (give, want). Returns the order id.
    #[payable]
    pub fn submit_order(&mut self, order: OrderInput, signature: String) -> String {
        let now_s = env::block_timestamp_ms() / 1000;
        require!((order.open_deadline as u64) >= now_s, "order's openDeadline has passed");
        require!((order.fill_deadline as u64) > now_s, "order's fillDeadline has passed");
        require!(order.give != order.want && order.give_amount.0 > 0 && order.min_want_amount.0 > 0, "bad order terms");
        let digest = order::order_digest(&order, self.chain_id).unwrap_or_else(|e| env::panic_str(&e));
        let signer = order::recover(&digest, &signature).unwrap_or_else(|e| env::panic_str(&e));
        require!(signer.eq_ignore_ascii_case(&order.user), format!("signed by {signer}, order is for {}", order.user));
        let digest_hex: String = digest.iter().map(|x| format!("{x:02x}")).collect();
        let id = digest_hex[..32].to_string();
        let key = order_key(&order.user, &order.give, &order.want);
        let rec = Order { id: id.clone(), input: order, filled: U128(0), digest: digest_hex };
        let payer = env::predecessor_account_id();
        self.with_storage(&payer, |s| {
            s.orders.insert(&id, &rec);
            s.order_by_key.insert(&key, &id);
        });
        emit("order_received", json!({ "order_id": id, "user": rec.input.user, "give": rec.input.give, "give_amount": rec.input.give_amount, "want": rec.input.want, "min_want_amount": rec.input.min_want_amount, "standard": "ERC-7683 GaslessCrossChainOrder (EIP-712)" }));
        id
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id)
    }

    pub fn order_for(&self, user: String, give: String, want: String) -> Option<Order> {
        self.order_by_key.get(&order_key(&user, &give, &want)).and_then(|id| self.orders.get(&id))
    }

    /// Anyone proposes a ring. The attached deposit covers its storage; the excess is refunded.
    #[payable]
    pub fn propose_ring(&mut self, legs: Vec<LegSpec>, deadline_ms: u64) -> String {
        let now = env::block_timestamp_ms();
        require!(deadline_ms > now && deadline_ms <= now + MAX_DEADLINE_AHEAD_MS, "deadline must be within the next hour");
        if let Err(e) = check_ring(&legs, self.fee_pips) {
            env::panic_str(&e);
        }
        // a leg whose signer has a live ERC-7683 order for (give, want) must respect it
        for (i, l) in legs.iter().enumerate() {
            if let Some(o) = self.order_for(l.agent.clone(), l.give.clone(), l.get.clone()) {
                if (o.input.fill_deadline as u64) * 1000 > now {
                    require!(l.give_amt.0 <= o.input.give_amount.0 - o.filled.0, format!("leg {i} gives more than order {} has left", o.id));
                    require!(
                        l.get_amt.0 * o.input.give_amount.0 >= o.input.min_want_amount.0 * l.give_amt.0,
                        format!("leg {i} pays less than order {}'s minimum price", o.id)
                    );
                }
            }
        }
        let proposer = env::predecessor_account_id();
        let seed = format!("{}|{}|{}|{}", serde_json::to_string(&legs).unwrap(), deadline_ms, proposer, env::block_height());
        let id = hex(&env::sha256(seed.as_bytes()))[..32].to_string();
        let k = legs.len();
        let ring = Ring {
            id: id.clone(),
            proposer: proposer.clone(),
            legs,
            deadline_ms,
            signed: vec![None; k],
            standards: vec![None; k],
            status: RingStatus::Open,
            closer: None,
            close_attempts: 0,
            created_ms: now,
            settled_ms: None,
        };
        self.with_storage(&proposer, |s| {
            s.rings.insert(&id, &ring);
            s.ring_ids.push(&id);
        });
        emit("ring_proposed", json!({ "ring_id": id, "proposer": proposer, "k": k, "legs": ring.legs, "deadline_ms": deadline_ms }));
        id
    }

    /// Anyone relays an agent's signed leg. It must commit to exactly what the ring needs.
    #[payable]
    pub fn attach_leg(&mut self, ring_id: String, index: u32, signed: String) {
        let mut ring = self.rings.get(&ring_id).unwrap_or_else(|| env::panic_str("unknown ring"));
        require!(ring.status == RingStatus::Open || ring.status == RingStatus::Failed, "ring is not open");
        require!(env::block_timestamp_ms() < ring.deadline_ms, "ring expired");
        let i = index as usize;
        require!(i < ring.legs.len(), "no such leg");
        let (standard, msg) = parse_signed(&signed).unwrap_or_else(|e| env::panic_str(&e));
        if let Err(e) = check_leg_message(&msg, &ring.legs[i], env::current_account_id().as_str(), self.verifier.as_str()) {
            env::panic_str(&e);
        }
        ring.signed[i] = Some(signed);
        ring.standards[i] = Some(standard.clone());
        let payer = env::predecessor_account_id();
        self.with_storage(&payer, |s| {
            s.rings.insert(&ring_id, &ring);
        });
        emit("leg_attached", json!({ "ring_id": ring_id, "index": index, "agent": ring.legs[i].agent, "standard": standard }));
    }

    /// Anyone closes a fully signed ring: one `execute_intents` on the Verifier. Attach >= 250 Tgas.
    pub fn close_ring(&mut self, ring_id: String) -> Promise {
        let mut ring = self.rings.get(&ring_id).unwrap_or_else(|| env::panic_str("unknown ring"));
        require!(ring.status == RingStatus::Open || ring.status == RingStatus::Failed, "ring is not open");
        require!(env::block_timestamp_ms() < ring.deadline_ms, "ring expired");
        require!(ring.signed.iter().all(Option::is_some), "not every leg is signed yet");
        require!(env::prepaid_gas().as_tgas() >= 240, "attach at least 250 Tgas");
        let signed: Vec<Value> = ring.signed.iter().map(|s| serde_json::from_str(s.as_ref().unwrap()).unwrap()).collect();
        ring.status = RingStatus::Closing;
        ring.close_attempts += 1;
        self.rings.insert(&ring_id, &ring);
        let closer = env::predecessor_account_id();
        Promise::new(self.verifier.clone())
            .function_call(
                "execute_intents".to_string(),
                serde_json::to_vec(&json!({ "signed": signed })).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(150),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(60))
                    .on_close(ring_id, closer),
            )
    }

    #[private]
    pub fn on_close(&mut self, ring_id: String, closer: AccountId, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let mut ring = self.rings.get(&ring_id).unwrap_or_else(|| env::panic_str("unknown ring"));
        let ok = result.is_ok();
        let tips = self.apply_outcome(&mut ring, &closer, ok, env::block_timestamp_ms());
        self.rings.insert(&ring_id, &ring);
        if ok {
            // pay the closer from this contract's own Verifier account (predecessor auth)
            for (token, amt) in &tips {
                Promise::new(self.verifier.clone())
                    .function_call(
                        "mt_transfer".to_string(),
                        serde_json::to_vec(&json!({ "receiver_id": closer, "token_id": token, "amount": amt.to_string() })).unwrap(),
                        NearToken::from_yoctonear(1),
                        Gas::from_tgas(15),
                    )
                    .detach();
            }
            emit("ring_settled", json!({ "ring_id": ring_id, "closer": closer, "k": ring.legs.len(), "tips": tips.iter().map(|(t, a)| json!({"token": t, "amt": a.to_string()})).collect::<Vec<_>>() }));
        } else {
            emit("ring_close_failed", json!({ "ring_id": ring_id, "closer": closer, "attempt": ring.close_attempts }));
        }
        ok
    }

    /// ERC-8004-style identity record for an agent id (NEAR account, hex implicit id or 0x address).
    /// A NEAR account registers itself; other ids are recorded with who registered them.
    pub fn register_agent(&mut self, agent: String, agent_uri: String) {
        let by = env::predecessor_account_id();
        let is_near_account = agent.parse::<AccountId>().is_ok() && !agent.starts_with("0x") && agent.len() != 64;
        require!(!is_near_account || by.as_str() == agent, "a NEAR account registers itself");
        require!(agent_uri.len() <= 256, "uri too long");
        let mut r = self.rep.get(&agent).unwrap_or_default();
        r.agent_uri = Some(agent_uri);
        r.registered_by = Some(by);
        self.rep.insert(&agent, &r);
        emit("agent_registered", json!({ "agent": agent }));
    }

    // ---- views ----
    pub fn get_ring(&self, ring_id: String) -> Option<Ring> {
        self.rings.get(&ring_id)
    }
    /// Newest first.
    pub fn rings(&self, from: u64, limit: u32) -> Vec<Ring> {
        let n = self.ring_ids.len();
        (0..n)
            .rev()
            .skip(from as usize)
            .take(limit.min(50) as usize)
            .filter_map(|i| self.ring_ids.get(i).and_then(|id| self.rings.get(&id)))
            .collect()
    }
    pub fn reputation(&self, agent: String) -> Reputation {
        self.rep.get(&agent).unwrap_or_default()
    }
    pub fn config(&self) -> Value {
        json!({ "owner": self.owner, "verifier": self.verifier, "fee_pips": self.fee_pips, "rings": self.ring_ids.len(), "settled": self.total_settled, "eip712_chain_id": self.chain_id })
    }
    pub fn check_ring_view(&self, legs: Vec<LegSpec>) -> Option<String> {
        check_ring(&legs, self.fee_pips).err()
    }

    pub fn set_chain_id(&mut self, chain_id: u64) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.chain_id = chain_id;
    }

    pub fn set_fee_pips(&mut self, fee_pips: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.fee_pips = fee_pips;
    }
}

impl Rings {
    /// Settlement bookkeeping, separated from promises so it is unit-testable.
    fn apply_outcome(&mut self, ring: &mut Ring, closer: &AccountId, ok: bool, now_ms: u64) -> Vec<(String, u128)> {
        let mut tips: Vec<(String, u128)> = Vec::new();
        if ok {
            ring.status = RingStatus::Settled;
            ring.closer = Some(closer.clone());
            ring.settled_ms = Some(now_ms);
            self.total_settled += 1;
            for l in &ring.legs {
                if let Some(mut o) = self.order_for(l.agent.clone(), l.give.clone(), l.get.clone()) {
                    o.filled = U128(o.filled.0 + l.give_amt.0);
                    self.orders.insert(&o.id.clone(), &o);
                }
                let mut r = self.rep.get(&l.agent).unwrap_or_default();
                r.rings_settled += 1;
                self.rep.insert(&l.agent, &r);
                if let Some(t) = &l.tip {
                    match tips.iter_mut().find(|(tok, _)| *tok == t.token) {
                        Some(e) => e.1 += t.amt.0,
                        None => tips.push((t.token.clone(), t.amt.0)),
                    }
                }
            }
            let mut c = self.rep.get(&closer.to_string()).unwrap_or_default();
            c.rings_closed += 1;
            self.rep.insert(&closer.to_string(), &c);
        } else {
            ring.status = RingStatus::Failed;
            for l in &ring.legs {
                let mut r = self.rep.get(&l.agent).unwrap_or_default();
                r.legs_in_failed_closes += 1;
                self.rep.insert(&l.agent, &r);
            }
        }
        tips
    }

    /// Runs `f`, charges the storage it added to `payer`'s attached deposit and refunds the rest.
    fn with_storage(&mut self, payer: &AccountId, f: impl FnOnce(&mut Self)) {
        let before = env::storage_usage();
        f(self);
        let used = env::storage_usage().saturating_sub(before) as u128;
        let cost = used * env::storage_byte_cost().as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, format!("attach at least {cost} yocto for storage ({used} bytes)"));
        if attached > cost {
            Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(attached - cost)).detach();
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests;
