//! Nomad offer board (`board.nomadswarm.testnet`).
//!
//! A public record of agent offers plus an advisory ring log. It enforces the
//! offer rules of `RULES.md` §2 and the `record_ring` permission of §6. It holds
//! no funds other than storage deposits, which are refunded when an offer is
//! replaced, cancelled or pruned.
//!
//! Storage accounting uses the legacy `near_sdk::collections` types on purpose:
//! they write to the trie immediately, so `env::storage_usage()` measured inside
//! a call reflects the bytes an offer really uses. (`near_sdk::store` caches
//! writes until the end of the call, which would make the measurement read 0.)
#![allow(deprecated)]

use std::ops::Bound;

use near_sdk::collections::{LookupMap, TreeMap, UnorderedSet};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

/// RULES.md §2.3: the TTL is at most 1 hour.
pub const MAX_TTL_MS: u64 = 60 * 60 * 1000;
/// Upper bound on token id length (NEP-245 style ids such as `nep141:wrap.testnet`).
pub const MAX_TOKEN_LEN: usize = 128;
/// The ring log keeps only the most recent `RING_LOG_CAP` entries.
pub const RING_LOG_CAP: u64 = 256;
/// RULES.md §3.1: a ring has 2 to 5 offers.
pub const MIN_RING_LEN: usize = 2;
pub const MAX_RING_LEN: usize = 5;
/// Max length of the `ring_id` and `tx_hash` strings in the ring log.
pub const MAX_RING_STR_LEN: usize = 128;
/// Max offers pruned in one call (bounds gas and the number of refund receipts).
pub const MAX_PRUNE: u32 = 100;
/// Max page size for views.
pub const MAX_PAGE: u32 = 200;
/// Suggested deposit for `post_offer`; the excess is refunded.
pub const OFFER_DEPOSIT_HINT: NearToken = NearToken::from_millinear(10);

pub const EVENT_STANDARD: &str = "nomad-board";
pub const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Offers,
    Expiry,
    ByPair,
    ByAgent,
    Matchers,
    Rings,
}

/// Public offer shape (TECH_DOC §4 / §7).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub id: u64,
    pub agent: AccountId,
    pub give: String,
    pub give_max: U128,
    pub want: String,
    pub rate_num: U128,
    pub rate_den: U128,
    pub expires_at_ms: u64,
    pub created_at_ms: u64,
}

/// What is stored: the offer plus the storage deposit that was charged for it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct StoredOffer {
    pub offer: Offer,
    pub storage_deposit: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RingRecord {
    /// Sequence number in the ring log (0-based, monotonic).
    pub seq: u64,
    pub ring_id: String,
    pub offer_ids: Vec<u64>,
    pub tx_hash: String,
    pub matcher: AccountId,
    pub recorded_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RulesInfo {
    pub sha256: String,
    pub url: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    /// Offers currently stored (includes expired ones not yet pruned).
    pub stored_offers: u64,
    pub total_posted: u64,
    pub total_replaced: u64,
    pub total_cancelled: u64,
    pub total_expired: u64,
    pub total_rings: u64,
    pub matchers: u64,
    pub next_offer_id: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    owner_id: AccountId,
    rules_sha256: String,
    rules_url: String,
    next_offer_id: u64,
    /// id -> offer, ordered by id (pagination cursor).
    offers: TreeMap<u64, StoredOffer>,
    /// (expires_at_ms, id) index used by `prune_expired`.
    expiry: TreeMap<(u64, u64), ()>,
    /// (agent, give, want) -> id: one live offer per pair.
    by_pair: LookupMap<(AccountId, String, String), u64>,
    /// agent -> ids of its offers.
    by_agent: LookupMap<AccountId, Vec<u64>>,
    matchers: UnorderedSet<AccountId>,
    /// Ring log ring buffer: slot (seq % RING_LOG_CAP) -> record.
    rings: LookupMap<u64, RingRecord>,
    ring_count: u64,
    total_posted: u64,
    total_replaced: u64,
    total_cancelled: u64,
    total_expired: u64,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn emit(event: &str, data: Value) {
    let ev = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&ev).unwrap()));
}

fn refund(to: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

fn offer_json<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap()
}

#[near]
impl Board {
    #[init]
    pub fn new(owner_id: AccountId, rules_sha256: String, rules_url: String) -> Self {
        Self {
            owner_id,
            rules_sha256,
            rules_url,
            next_offer_id: 0,
            offers: TreeMap::new(StorageKey::Offers),
            expiry: TreeMap::new(StorageKey::Expiry),
            by_pair: LookupMap::new(StorageKey::ByPair),
            by_agent: LookupMap::new(StorageKey::ByAgent),
            matchers: UnorderedSet::new(StorageKey::Matchers),
            rings: LookupMap::new(StorageKey::Rings),
            ring_count: 0,
            total_posted: 0,
            total_replaced: 0,
            total_cancelled: 0,
            total_expired: 0,
        }
    }

    // ------------------------------------------------------------------ writes

    /// Post (or replace) the caller's offer for (give, want). Returns the new id.
    /// The attached deposit must cover the storage used; the excess (plus the
    /// deposit of a replaced offer) is refunded to the caller.
    #[payable]
    pub fn post_offer(
        &mut self,
        give: String,
        give_max: U128,
        want: String,
        rate_num: U128,
        rate_den: U128,
        ttl_ms: u64,
    ) -> u64 {
        let agent = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();

        require!(!give.is_empty() && !want.is_empty(), "give and want must be non-empty");
        require!(
            give.len() <= MAX_TOKEN_LEN && want.len() <= MAX_TOKEN_LEN,
            "token id too long"
        );
        require!(give != want, "give and want must be different tokens");
        require!(give_max.0 > 0, "give_max must be > 0");
        require!(rate_num.0 > 0, "rate_num must be > 0");
        require!(rate_den.0 > 0, "rate_den must be > 0");
        require!(ttl_ms > 0, "ttl_ms must be > 0");
        require!(ttl_ms <= MAX_TTL_MS, "ttl_ms must be <= 3600000 (1 hour)");

        // Replace an existing offer for the same pair: its deposit is credited back.
        let key = (agent.clone(), give.clone(), want.clone());
        let mut credit: u128 = 0;
        let mut replaced: Option<u64> = None;
        if let Some(old_id) = self.by_pair.get(&key) {
            let old = self.remove_offer(old_id);
            credit = old.storage_deposit;
            replaced = Some(old_id);
            self.total_replaced += 1;
        }

        let now = now_ms();
        let id = self.next_offer_id;
        self.next_offer_id += 1;
        let offer = Offer {
            id,
            agent: agent.clone(),
            give,
            give_max,
            want,
            rate_num,
            rate_den,
            expires_at_ms: now + ttl_ms,
            created_at_ms: now,
        };
        let cost_before = env::storage_usage();
        self.insert_offer(&offer, 0);
        let bytes = env::storage_usage().saturating_sub(cost_before);
        let required = env::storage_byte_cost().as_yoctonear() * bytes as u128;
        // Record the deposit charged (rewrite with the real value; same size).
        self.offers.insert(&id, &StoredOffer { offer: offer.clone(), storage_deposit: required });

        let available = attached + credit;
        require!(
            available >= required,
            format!(
                "insufficient storage deposit: attached {} yocto, required {} yocto ({} bytes)",
                attached, required, bytes
            )
        );
        refund(&agent, available - required);
        self.total_posted += 1;

        let mut data = offer_json(&offer);
        data["storage_deposit"] = json!(U128(required));
        if let Some(r) = replaced {
            data["replaced_id"] = json!(r);
        }
        emit("offer_posted", data);
        id
    }

    /// Cancel one of the caller's offers. Refunds its storage deposit.
    pub fn cancel_offer(&mut self, id: u64) {
        let stored = self.offers.get(&id).unwrap_or_else(|| env::panic_str("offer not found"));
        require!(
            stored.offer.agent == env::predecessor_account_id(),
            "only the offer's agent can cancel it"
        );
        let stored = self.remove_offer(id);
        refund(&stored.offer.agent, stored.storage_deposit);
        self.total_cancelled += 1;
        emit(
            "offer_cancelled",
            json!({ "id": id, "agent": stored.offer.agent, "refund": U128(stored.storage_deposit) }),
        );
    }

    /// Remove up to `limit` expired offers (oldest expiry first) and refund
    /// their storage to the owners. Anyone may call. Returns the number pruned.
    pub fn prune_expired(&mut self, limit: u32) -> u32 {
        let limit = limit.min(MAX_PRUNE);
        let now = now_ms();
        let expired: Vec<u64> = self
            .expiry
            .iter()
            .take_while(|((exp, _), _)| *exp <= now)
            .take(limit as usize)
            .map(|((_, id), _)| id)
            .collect();
        let pruner = env::predecessor_account_id();
        for id in &expired {
            let stored = self.remove_offer(*id);
            refund(&stored.offer.agent, stored.storage_deposit);
            self.total_expired += 1;
            emit(
                "offer_expired",
                json!({
                    "id": id,
                    "agent": stored.offer.agent,
                    "expires_at_ms": stored.offer.expires_at_ms,
                    "refund": U128(stored.storage_deposit),
                    "pruned_by": pruner,
                }),
            );
        }
        expired.len() as u32
    }

    /// Advisory ring log (RULES.md §4.6). Registered matchers only. The log is a
    /// ring buffer of the last `RING_LOG_CAP` entries, paid for by the contract.
    pub fn record_ring(&mut self, ring_id: String, offer_ids: Vec<u64>, tx_hash: String) {
        let matcher = env::predecessor_account_id();
        require!(self.matchers.contains(&matcher), "only registered matchers can record rings");
        require!(
            !ring_id.is_empty() && ring_id.len() <= MAX_RING_STR_LEN,
            "ring_id must be 1..=128 chars"
        );
        require!(
            !tx_hash.is_empty() && tx_hash.len() <= MAX_RING_STR_LEN,
            "tx_hash must be 1..=128 chars"
        );
        require!(
            offer_ids.len() >= MIN_RING_LEN && offer_ids.len() <= MAX_RING_LEN,
            "a ring has 2 to 5 offers"
        );
        let seq = self.ring_count;
        let rec = RingRecord {
            seq,
            ring_id,
            offer_ids,
            tx_hash,
            matcher,
            recorded_at_ms: now_ms(),
        };
        self.rings.insert(&(seq % RING_LOG_CAP), &rec);
        self.ring_count += 1;
        emit("ring_recorded", offer_json(&rec));
    }

    // ------------------------------------------------------------------ owner

    pub fn add_matcher(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        self.matchers.insert(&account_id)
    }

    pub fn remove_matcher(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        self.matchers.remove(&account_id)
    }

    pub fn set_rules(&mut self, sha256: String, url: String) {
        self.assert_owner();
        self.rules_sha256 = sha256;
        self.rules_url = url;
    }

    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.assert_owner();
        self.owner_id = owner_id;
    }

    // ------------------------------------------------------------------ views

    /// Live (non-expired) offers with id >= `from`, ascending by id, up to
    /// `limit` (max 200). Next page: `from = last.id + 1`.
    pub fn offers(&self, from: u64, limit: u32) -> Vec<Offer> {
        let now = now_ms();
        self.offers
            .range((Bound::Included(from), Bound::Unbounded))
            .map(|(_, s)| s.offer)
            .filter(|o| o.expires_at_ms > now)
            .take(limit.min(MAX_PAGE) as usize)
            .collect()
    }

    /// The agent's live (non-expired) offers.
    pub fn offers_by_agent(&self, agent: AccountId) -> Vec<Offer> {
        let now = now_ms();
        self.by_agent
            .get(&agent)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.offers.get(&id))
            .map(|s| s.offer)
            .filter(|o| o.expires_at_ms > now)
            .collect()
    }

    /// Any stored offer by id, including an expired one not yet pruned.
    pub fn get_offer(&self, id: u64) -> Option<Offer> {
        self.offers.get(&id).map(|s| s.offer)
    }

    pub fn rules(&self) -> RulesInfo {
        RulesInfo { sha256: self.rules_sha256.clone(), url: self.rules_url.clone() }
    }

    /// Ring log entries with seq >= `from` that are still retained, ascending.
    pub fn rings(&self, from: u64, limit: u32) -> Vec<RingRecord> {
        let oldest = self.ring_count.saturating_sub(RING_LOG_CAP);
        let start = from.max(oldest);
        let end = self.ring_count.min(start.saturating_add(limit.min(MAX_PAGE) as u64));
        (start..end).filter_map(|seq| self.rings.get(&(seq % RING_LOG_CAP))).collect()
    }

    pub fn stats(&self) -> Stats {
        Stats {
            stored_offers: self.offers.len(),
            total_posted: self.total_posted,
            total_replaced: self.total_replaced,
            total_cancelled: self.total_cancelled,
            total_expired: self.total_expired,
            total_rings: self.ring_count,
            matchers: self.matchers.len(),
            next_offer_id: self.next_offer_id,
        }
    }

    pub fn matchers(&self) -> Vec<AccountId> {
        self.matchers.to_vec()
    }

    pub fn is_matcher(&self, account_id: AccountId) -> bool {
        self.matchers.contains(&account_id)
    }

    pub fn owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// A deposit that comfortably covers one offer; the excess is refunded.
    pub fn offer_deposit_hint(&self) -> U128 {
        U128(OFFER_DEPOSIT_HINT.as_yoctonear())
    }

    /// Storage deposit held for an offer.
    pub fn offer_storage_deposit(&self, id: u64) -> Option<U128> {
        self.offers.get(&id).map(|s| U128(s.storage_deposit))
    }
}

impl Board {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn insert_offer(&mut self, offer: &Offer, storage_deposit: u128) {
        self.offers
            .insert(&offer.id, &StoredOffer { offer: offer.clone(), storage_deposit });
        self.expiry.insert(&(offer.expires_at_ms, offer.id), &());
        self.by_pair
            .insert(&(offer.agent.clone(), offer.give.clone(), offer.want.clone()), &offer.id);
        let mut ids = self.by_agent.get(&offer.agent).unwrap_or_default();
        ids.push(offer.id);
        self.by_agent.insert(&offer.agent, &ids);
    }

    fn remove_offer(&mut self, id: u64) -> StoredOffer {
        let stored = self.offers.remove(&id).unwrap_or_else(|| env::panic_str("offer not found"));
        let o = &stored.offer;
        self.expiry.remove(&(o.expires_at_ms, id));
        self.by_pair.remove(&(o.agent.clone(), o.give.clone(), o.want.clone()));
        let mut ids = self.by_agent.get(&o.agent).unwrap_or_default();
        ids.retain(|x| *x != id);
        if ids.is_empty() {
            self.by_agent.remove(&o.agent);
        } else {
            self.by_agent.insert(&o.agent, &ids);
        }
        stored
    }
}

#[cfg(test)]
mod tests;
