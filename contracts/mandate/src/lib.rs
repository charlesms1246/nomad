//! Nomad agent mandate (`mandate.nomadswarm.testnet`).
//!
//! An owner registers a mandate: which tokens its agent may give, how much per
//! leg and per UTC day, the minimum price per (give, want) pair, and an expiry.
//! Anyone (typically a ring proposer) can then ask for a leg signature. The
//! contract checks the leg against the mandate, builds the exact ERC-191
//! intents message the NEAR Intents Verifier expects for the agent's derived
//! Ethereum address, and asks the NEAR MPC signer (chain signatures) to sign its
//! prehash under the path `mandate/<owner>`. No hot key exists: the only way to
//! get a signature for that address is through these checks.
//!
//! The derived address is supplied by the owner at creation (computed off-chain
//! from the MPC `derived_public_key` view). The callback recovers the signer of
//! every MPC signature with `ecrecover` and refuses to store it unless it matches
//! that address, so a wrong address can never produce a usable leg.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
};

pub const MAX_TOKEN_LEN: usize = 128;
pub const MAX_TOKENS: usize = 16;
pub const MAX_PRICES: usize = 32;
/// A leg deadline is at most 1 hour ahead (keeps the daily budget meaningful).
pub const MAX_LEG_TTL_MS: u64 = 60 * 60 * 1000;
pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Attached to `create_mandate` (storage); the excess stays as the mandate's storage stake.
pub const MANDATE_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// Attached to `request_leg_signature`: storage for the signed leg plus the MPC's 1 yocto.
pub const LEG_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// v1.signer: SIGN_DEPOSIT_YOCTONEAR = 1.
pub const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// v1.signer requires at least 15 Tgas attached to `sign`.
pub const MPC_SIGN_GAS: Gas = Gas::from_tgas(30);
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Verifier versioned nonce magic (defuse core `nonce/versioned.rs`).
pub const NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Mandates,
    Legs,
    UsedNonces,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenRule {
    pub token: String,
    pub max_per_leg: U128,
    pub daily_budget: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceRule {
    pub give: String,
    pub want: String,
    /// Minimum `want` per `give` in smallest units: get_amount / give_amount >= rate_num / rate_den.
    pub rate_num: U128,
    pub rate_den: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Spent {
    pub token: String,
    pub day: u64,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    pub owner: AccountId,
    pub path: String,
    /// Lowercase 0x address: the Verifier signer_id of this agent.
    pub eth_address: String,
    /// Set once an MPC signature has been recovered to `eth_address`.
    pub address_verified: bool,
    pub tokens: Vec<TokenRule>,
    pub prices: Vec<PriceRule>,
    pub min_counterparty_reputation: Option<u32>,
    pub expires_at_ms: u64,
    pub spent: Vec<Spent>,
    pub legs_signed: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MandateArgs {
    pub eth_address: String,
    pub tokens: Vec<TokenRule>,
    pub prices: Vec<PriceRule>,
    pub min_counterparty_reputation: Option<u32>,
    pub expires_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tip {
    pub token: String,
    pub amount: U128,
    pub receiver_id: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Leg {
    /// Whose mandate signs this leg.
    pub owner: AccountId,
    pub give: String,
    pub give_amount: U128,
    pub get: String,
    pub get_amount: U128,
    /// Intent deadline, ms since epoch.
    pub deadline_ms: u64,
    /// 32-byte Verifier versioned nonce (magic, V1, salt, deadline ns, 15 random bytes).
    pub nonce: Base64VecU8,
    /// Current Verifier salt, 4 bytes hex; must equal the salt inside the nonce.
    pub salt: String,
    pub tip: Option<Tip>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum LegStatus {
    Pending,
    Signed,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct StoredLeg {
    pub id: u64,
    pub leg: Leg,
    pub signer_id: String,
    pub verifying_contract: AccountId,
    /// The exact JSON message signed (ERC-191 payload).
    pub payload: String,
    /// keccak256("\x19Ethereum Signed Message:\n" + len + payload), hex.
    pub prehash: String,
    pub day: u64,
    pub status: LegStatus,
    /// `secp256k1:<base58 of r‖s‖v>`, v in {0,1}.
    pub signature: Option<String>,
    pub error: Option<String>,
    pub requested_by: AccountId,
    pub requested_at_ms: u64,
}

/// A Verifier `MultiPayload` of standard `erc191`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Erc191MultiPayload {
    pub standard: String,
    pub payload: String,
    pub signature: String,
}

#[near(serializers = [json])]
pub struct PayloadPreview {
    pub payload: String,
    pub prehash: String,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub verifier_id: AccountId,
    pub mpc_id: AccountId,
    pub next_leg_id: u64,
    pub leg_deposit: U128,
    pub mandate_deposit: U128,
}

/// What `signed_leg` returns: the stored leg plus the ready-to-submit MultiPayload.
#[near(serializers = [json])]
pub struct LegView {
    pub id: u64,
    pub status: LegStatus,
    pub leg: Leg,
    pub signer_id: String,
    pub prehash: String,
    pub error: Option<String>,
    /// `{"standard":"erc191","payload":..,"signature":..}` once signed.
    pub multi_payload: Option<Erc191MultiPayload>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    verifier_id: AccountId,
    mpc_id: AccountId,
    mandates: LookupMap<AccountId, Mandate>,
    legs: LookupMap<u64, StoredLeg>,
    used_nonces: LookupMap<Vec<u8>, u64>,
    next_leg_id: u64,
}

// ---------- pure helpers (unit tested) ----------

pub fn is_eth_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// 128x128 -> 256-bit multiply, returned as (hi, lo).
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & u64::MAX as u128) + (p10 & u64::MAX as u128);
    let lo = (p00 & u64::MAX as u128) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// get / give >= num / den, i.e. get * den >= give * num, exactly.
pub fn price_ok(give: u128, get: u128, num: u128, den: u128) -> bool {
    mul_wide(get, den) >= mul_wide(give, num)
}

/// RFC 3339 UTC with millisecond precision, e.g. `2026-11-14T15:04:05.123Z`.
pub fn rfc3339_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

pub fn erc191_prehash(msg: &str) -> [u8; 32] {
    let mut buf = Vec::with_capacity(msg.len() + 40);
    buf.extend_from_slice(b"\x19Ethereum Signed Message:\n");
    buf.extend_from_slice(msg.len().to_string().as_bytes());
    buf.extend_from_slice(msg.as_bytes());
    env::keccak256_array(&buf)
}

/// Ethereum address of a 64-byte uncompressed public key (without the 0x04 prefix).
pub fn eth_address_of(pk64: &[u8; 64]) -> String {
    let h = env::keccak256_array(pk64);
    format!("0x{}", hex(&h[12..]))
}

/// The exact ERC-191 payload: a Verifier `DefusePayload` with one `token_diff`
/// (and an optional `transfer` for the matcher tip).
pub fn build_payload(leg: &Leg, signer_id: &str, verifier: &AccountId) -> String {
    let mut diff = serde_json::Map::new();
    diff.insert(leg.give.clone(), Value::String(format!("-{}", leg.give_amount.0)));
    diff.insert(leg.get.clone(), Value::String(leg.get_amount.0.to_string()));
    let mut intents = vec![json!({"intent": "token_diff", "diff": diff})];
    if let Some(t) = &leg.tip {
        intents.push(json!({
            "intent": "transfer",
            "receiver_id": t.receiver_id,
            "tokens": { t.token.clone(): t.amount.0.to_string() },
        }));
    }
    let nonce_b64 = serde_json::to_value(&leg.nonce).unwrap();
    json!({
        "signer_id": signer_id,
        "verifying_contract": verifier,
        "deadline": rfc3339_ms(leg.deadline_ms),
        "nonce": nonce_b64,
        "intents": intents,
    })
    .to_string()
}

fn valid_token(t: &str) -> bool {
    !t.is_empty() && t.len() <= MAX_TOKEN_LEN
}

impl Mandate {
    pub fn rule(&self, token: &str) -> Option<&TokenRule> {
        self.tokens.iter().find(|r| r.token == token)
    }

    pub fn spent_today(&self, token: &str, day: u64) -> u128 {
        self.spent.iter().find(|s| s.token == token && s.day == day).map(|s| s.amount.0).unwrap_or(0)
    }

    /// Per-token gross outflow of a leg: give amount plus the tip.
    pub fn outflows(leg: &Leg) -> Vec<(String, u128)> {
        let mut v = vec![(leg.give.clone(), leg.give_amount.0)];
        if let Some(t) = &leg.tip {
            if t.amount.0 > 0 {
                match v.iter_mut().find(|(k, _)| *k == t.token) {
                    Some(e) => e.1 = e.1.checked_add(t.amount.0).expect("overflow"),
                    None => v.push((t.token.clone(), t.amount.0)),
                }
            }
        }
        v
    }

    /// Every rule a leg must satisfy. Returns the outflows to charge on success.
    pub fn check_leg(&self, leg: &Leg, now_ms: u64) -> Result<Vec<(String, u128)>, String> {
        if now_ms >= self.expires_at_ms {
            return Err("mandate expired".into());
        }
        if leg.give == leg.get {
            return Err("give == get".into());
        }
        if leg.give_amount.0 == 0 || leg.get_amount.0 == 0 {
            return Err("zero amount".into());
        }
        if leg.deadline_ms <= now_ms {
            return Err("deadline in the past".into());
        }
        if leg.deadline_ms > self.expires_at_ms {
            return Err("deadline after mandate expiry".into());
        }
        if leg.deadline_ms > now_ms + MAX_LEG_TTL_MS {
            return Err("deadline more than 1 hour ahead".into());
        }
        if self.rule(&leg.give).is_none() {
            return Err(format!("token not allowed: {}", leg.give));
        }
        if self.rule(&leg.get).is_none() {
            return Err(format!("token not allowed: {}", leg.get));
        }
        let price = self
            .prices
            .iter()
            .find(|p| p.give == leg.give && p.want == leg.get)
            .ok_or_else(|| format!("no price rule for {} -> {}", leg.give, leg.get))?;
        let outflows = Self::outflows(leg);
        // The price is judged on everything given in the give token (tip included if same token).
        let give_total = outflows.iter().find(|(k, _)| *k == leg.give).unwrap().1;
        if !price_ok(give_total, leg.get_amount.0, price.rate_num.0, price.rate_den.0) {
            return Err(format!(
                "below min price: get {} for give {} < {}/{}",
                leg.get_amount.0, give_total, price.rate_num.0, price.rate_den.0
            ));
        }
        // nonce: versioned V1 with the given salt and a deadline covering the intent deadline
        let n = &leg.nonce.0;
        if n.len() != 32 {
            return Err("nonce must be 32 bytes".into());
        }
        if n[0..4] != NONCE_MAGIC || n[4] != 0 {
            return Err("nonce must be a versioned V1 nonce".into());
        }
        let salt = unhex(&leg.salt).filter(|s| s.len() == 4).ok_or("salt must be 4 bytes hex")?;
        if n[5..9] != salt[..] {
            return Err("nonce salt != salt".into());
        }
        let nonce_deadline_ns = i64::from_le_bytes(n[9..17].try_into().unwrap());
        let want_ns = (leg.deadline_ms as i128) * 1_000_000;
        if (nonce_deadline_ns as i128) < want_ns {
            return Err("nonce deadline before intent deadline".into());
        }
        if (nonce_deadline_ns as i128) > (self.expires_at_ms as i128) * 1_000_000 {
            return Err("nonce deadline after mandate expiry".into());
        }
        let day = now_ms / DAY_MS;
        for (token, amt) in &outflows {
            let rule = self.rule(token).ok_or_else(|| format!("token not allowed: {}", token))?;
            if *amt > rule.max_per_leg.0 {
                return Err(format!("{} {} over per-leg max {}", token, amt, rule.max_per_leg.0));
            }
            let after = self.spent_today(token, day).checked_add(*amt).ok_or("overflow")?;
            if after > rule.daily_budget.0 {
                return Err(format!(
                    "{} over daily budget: spent {} + {} > {}",
                    token,
                    self.spent_today(token, day),
                    amt,
                    rule.daily_budget.0
                ));
            }
        }
        Ok(outflows)
    }

    pub fn charge(&mut self, outflows: &[(String, u128)], day: u64) {
        self.spent.retain(|s| s.day == day);
        for (token, amt) in outflows {
            match self.spent.iter_mut().find(|s| s.token == *token) {
                Some(s) => s.amount = U128(s.amount.0 + amt),
                None => self.spent.push(Spent { token: token.clone(), day, amount: U128(*amt) }),
            }
        }
    }

    pub fn refund(&mut self, outflows: &[(String, u128)], day: u64) {
        for (token, amt) in outflows {
            if let Some(s) = self.spent.iter_mut().find(|s| s.token == *token && s.day == day) {
                s.amount = U128(s.amount.0.saturating_sub(*amt));
            }
        }
    }
}

fn validate_args(a: &MandateArgs, now_ms: u64) {
    require!(is_eth_address(&a.eth_address), "eth_address must be a lowercase 0x address");
    require!(a.expires_at_ms > now_ms, "expiry in the past");
    require!(!a.tokens.is_empty() && a.tokens.len() <= MAX_TOKENS, "1..=16 tokens");
    require!(a.prices.len() <= MAX_PRICES, "at most 32 price rules");
    for (i, t) in a.tokens.iter().enumerate() {
        require!(valid_token(&t.token), "bad token id");
        require!(a.tokens[..i].iter().all(|o| o.token != t.token), "duplicate token");
    }
    for p in &a.prices {
        require!(p.rate_den.0 > 0, "rate_den must be > 0");
        require!(p.give != p.want, "price give == want");
        require!(a.tokens.iter().any(|t| t.token == p.give), "price give token not allowed");
        require!(a.tokens.iter().any(|t| t.token == p.want), "price want token not allowed");
    }
}

/// Parse the MPC `sign` response into r‖s and the recovery id.
pub fn parse_mpc_signature(v: &Value) -> Option<([u8; 64], u8)> {
    let big_r = unhex(v.get("big_r")?.get("affine_point")?.as_str()?)?;
    let s = unhex(v.get("s")?.get("scalar")?.as_str()?)?;
    let rid = v.get("recovery_id")?.as_u64()?;
    if big_r.len() != 33 || s.len() != 32 || rid > 3 {
        return None;
    }
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&big_r[1..]);
    out[32..].copy_from_slice(&s);
    Some((out, rid as u8))
}

/// Find v in {0,1} such that ecrecover(prehash, rs, v) is `addr`; malleable (high-s) signatures are refused
/// exactly as the Verifier does.
pub fn recover_v(prehash: &[u8; 32], rs: &[u8; 64], hint: u8, addr: &str) -> Option<u8> {
    let order = if hint & 1 == 0 { [0u8, 1] } else { [1u8, 0] };
    order.into_iter().find(|v| {
        env::ecrecover(prehash, rs, *v, true).map(|pk| eth_address_of(&pk) == addr).unwrap_or(false)
    })
}

#[near]
impl Contract {
    #[init]
    pub fn new(verifier_id: AccountId, mpc_id: AccountId) -> Self {
        Self {
            verifier_id,
            mpc_id,
            mandates: LookupMap::new(StorageKey::Mandates),
            legs: LookupMap::new(StorageKey::Legs),
            used_nonces: LookupMap::new(StorageKey::UsedNonces),
            next_leg_id: 0,
        }
    }

    /// Create or replace the caller's mandate. Spending counters survive a replace.
    #[payable]
    pub fn set_mandate(&mut self, args: MandateArgs) -> Mandate {
        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        validate_args(&args, now);
        let prev = self.mandates.get(&owner).cloned();
        if prev.is_none() {
            require!(env::attached_deposit() >= MANDATE_DEPOSIT, "attach 0.02 NEAR for a new mandate");
        }
        let (spent, legs_signed, verified) = match &prev {
            Some(p) => (p.spent.clone(), p.legs_signed, p.address_verified && p.eth_address == args.eth_address),
            None => (vec![], 0, false),
        };
        let m = Mandate {
            path: format!("mandate/{}", owner),
            owner: owner.clone(),
            eth_address: args.eth_address,
            address_verified: verified,
            tokens: args.tokens,
            prices: args.prices,
            min_counterparty_reputation: args.min_counterparty_reputation,
            expires_at_ms: args.expires_at_ms,
            spent,
            legs_signed,
        };
        self.mandates.insert(owner.clone(), m.clone());
        log_event("mandate_set", json!({"owner": owner, "eth_address": m.eth_address, "expires_at_ms": m.expires_at_ms}));
        m
    }

    /// Delete the caller's mandate (no more signatures). Signed legs already handed out stay valid
    /// until their deadline; the owner can still invalidate them in the Verifier.
    pub fn revoke_mandate(&mut self) {
        let owner = env::predecessor_account_id();
        require!(self.mandates.remove(&owner).is_some(), "no mandate");
        log_event("mandate_revoked", json!({"owner": owner}));
    }

    /// Check a leg against `leg.owner`'s mandate and, if it passes, ask the MPC to sign it.
    /// Returns the leg id at once; the signature arrives in a callback a few blocks later
    /// (poll `signed_leg(id)`). Attach 0.01 NEAR and at least 100 Tgas.
    #[payable]
    pub fn request_leg_signature(&mut self, leg: Leg) -> Promise {
        require!(env::attached_deposit() >= LEG_DEPOSIT, "attach 0.01 NEAR");
        let now = env::block_timestamp_ms();
        let mut m = self.mandates.get(&leg.owner).cloned().unwrap_or_else(|| env::panic_str("no mandate for owner"));
        let outflows = m.check_leg(&leg, now).unwrap_or_else(|e| env::panic_str(&format!("mandate: {}", e)));
        let mut nonce_key = leg.owner.as_bytes().to_vec();
        nonce_key.extend_from_slice(&leg.nonce.0);
        require!(!self.used_nonces.contains_key(&nonce_key), "mandate: nonce already used");

        let day = now / DAY_MS;
        m.charge(&outflows, day);
        let id = self.next_leg_id;
        self.next_leg_id += 1;
        self.used_nonces.insert(nonce_key, id);

        let payload = build_payload(&leg, &m.eth_address, &self.verifier_id);
        let prehash = erc191_prehash(&payload);
        let path = m.path.clone();
        self.mandates.insert(leg.owner.clone(), m);
        self.legs.insert(
            id,
            StoredLeg {
                id,
                leg,
                signer_id: String::new(),
                verifying_contract: self.verifier_id.clone(),
                payload,
                prehash: hex(&prehash),
                day,
                status: LegStatus::Pending,
                signature: None,
                error: None,
                requested_by: env::predecessor_account_id(),
                requested_at_ms: now,
            },
        );
        let args = json!({"request": {"payload_v2": {"Ecdsa": hex(&prehash)}, "path": path, "domain_id": 0}});
        Promise::new(self.mpc_id.clone())
            .function_call_weight(
                "sign".to_string(),
                args.to_string().into_bytes(),
                MPC_SIGN_DEPOSIT,
                MPC_SIGN_GAS,
                GasWeight(1),
            )
            .then(
                Promise::new(env::current_account_id()).function_call_weight(
                    "on_signed".to_string(),
                    json!({"id": id}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    CALLBACK_GAS,
                    GasWeight(0),
                ),
            )
    }

    #[private]
    pub fn on_signed(&mut self, id: u64, #[callback_result] res: Result<Value, PromiseError>) -> Option<String> {
        let mut leg = self.legs.get(&id).cloned().expect("no leg");
        let owner = leg.leg.owner.clone();
        let mandate = self.mandates.get(&owner).cloned();
        let outcome: Result<(String, String), String> = (|| {
            let v = res.map_err(|_| "MPC sign failed or timed out".to_string())?;
            let m = mandate.as_ref().ok_or("mandate revoked before the signature arrived")?;
            let (rs, hint) = parse_mpc_signature(&v).ok_or_else(|| format!("unexpected MPC response {}", v))?;
            let prehash: [u8; 32] = unhex(&leg.prehash).unwrap().try_into().unwrap();
            let v = recover_v(&prehash, &rs, hint, &m.eth_address)
                .ok_or("signature does not recover to the mandate's eth_address")?;
            let mut sig = rs.to_vec();
            sig.push(v);
            Ok((m.eth_address.clone(), format!("secp256k1:{}", bs58::encode(sig).into_string())))
        })();
        match outcome {
            Ok((addr, sig)) => {
                leg.status = LegStatus::Signed;
                leg.signer_id = addr;
                leg.signature = Some(sig.clone());
                if let Some(mut m) = mandate {
                    m.address_verified = true;
                    m.legs_signed += 1;
                    self.mandates.insert(owner.clone(), m);
                }
                log_event("leg_signed", json!({"id": id, "owner": owner}));
                self.legs.insert(id, leg);
                Some(sig)
            }
            Err(e) => {
                if let Some(mut m) = mandate {
                    m.refund(&Mandate::outflows(&leg.leg), leg.day);
                    self.mandates.insert(owner.clone(), m);
                }
                log_event("leg_failed", json!({"id": id, "owner": owner, "error": e}));
                leg.status = LegStatus::Failed;
                leg.error = Some(e);
                self.legs.insert(id, leg);
                None
            }
        }
    }

    // ---------- views ----------

    pub fn signed_leg(&self, id: u64) -> Option<LegView> {
        self.legs.get(&id).map(|l| LegView {
            id: l.id,
            status: l.status.clone(),
            leg: l.leg.clone(),
            signer_id: l.signer_id.clone(),
            prehash: l.prehash.clone(),
            error: l.error.clone(),
            multi_payload: l
                .signature
                .as_ref()
                .map(|s| Erc191MultiPayload {
                    standard: "erc191".into(),
                    payload: l.payload.clone(),
                    signature: s.clone(),
                }),
        })
    }

    /// The exact message and prehash `request_leg_signature` would sign (no checks).
    pub fn preview_payload(&self, leg: Leg) -> PayloadPreview {
        let m = self.mandates.get(&leg.owner).expect("no mandate for owner");
        let payload = build_payload(&leg, &m.eth_address, &self.verifier_id);
        PayloadPreview { prehash: hex(&erc191_prehash(&payload)), payload }
    }

    /// Dry-run the checks: `null` if the leg would be accepted now, else the reason.
    pub fn check_leg(&self, leg: Leg) -> Option<String> {
        let m = self.mandates.get(&leg.owner)?;
        m.check_leg(&leg, env::block_timestamp_ms()).err()
    }

    pub fn mandate(&self, owner: AccountId) -> Option<Mandate> {
        self.mandates.get(&owner).cloned()
    }

    pub fn spent_today(&self, owner: AccountId, token: String) -> U128 {
        U128(
            self.mandates
                .get(&owner)
                .map(|m| m.spent_today(&token, env::block_timestamp_ms() / DAY_MS))
                .unwrap_or(0),
        )
    }

    pub fn config(&self) -> ConfigView {
        ConfigView {
            verifier_id: self.verifier_id.clone(),
            mpc_id: self.mpc_id.clone(),
            next_leg_id: self.next_leg_id,
            leg_deposit: U128(LEG_DEPOSIT.as_yoctonear()),
            mandate_deposit: U128(MANDATE_DEPOSIT.as_yoctonear()),
        }
    }
}

fn log_event(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "nomad-mandate", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[cfg(test)]
mod tests;
