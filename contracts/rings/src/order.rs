//! ERC-7683 order ingress: an EVM wallet signs a standard `GaslessCrossChainOrder` (EIP-712) whose
//! `orderData` is a Nomad leg. The contract recomputes the EIP-712 digest on chain, recovers the
//! signer with `ecrecover`, and records the order as a standing limit for that 0x address. A ring
//! that includes a leg for this address must then respect the order (tokens, max give, min price).
//!
//! Constants (shared with packages/intents/src/erc7683.ts and its golden vector):
//!   domain  = EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//!             {name: "Nomad", version: "1", chainId: 397, verifyingContract: 0x0}
//!   order   = GaslessCrossChainOrder(address originSettler,address user,uint256 nonce,
//!             uint256 originChainId,uint32 openDeadline,uint32 fillDeadline,bytes32 orderDataType,bytes orderData)
//!   orderDataType = keccak256("NomadLeg(string give,uint256 giveAmount,string want,uint256 minWantAmount)")
//!   orderData     = abi.encode(string give, uint256 giveAmount, string want, uint256 minWantAmount)

use near_sdk::env;
use near_sdk::json_types::U128;
use near_sdk::near;

pub const CHAIN_ID: u64 = 397;
pub const DOMAIN_NAME: &str = "Nomad";
pub const DOMAIN_VERSION: &str = "1";
const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const ORDER_TYPE: &str = "GaslessCrossChainOrder(address originSettler,address user,uint256 nonce,uint256 originChainId,uint32 openDeadline,uint32 fillDeadline,bytes32 orderDataType,bytes orderData)";
const LEG_TYPE: &str = "NomadLeg(string give,uint256 giveAmount,string want,uint256 minWantAmount)";

/// The order as submitted (JSON). Integers are decimal strings; addresses are 0x-hex.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct OrderInput {
    pub user: String,
    pub nonce: U128,
    pub open_deadline: u32,
    pub fill_deadline: u32,
    pub give: String,
    pub give_amount: U128,
    pub want: String,
    pub min_want_amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Order {
    pub id: String,
    pub input: OrderInput,
    /// How much of `give_amount` rings have used so far.
    pub filled: U128,
    pub digest: String,
}

pub fn keccak(b: &[u8]) -> [u8; 32] {
    env::keccak256_array(b)
}

fn word_u128(x: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&x.to_be_bytes());
    w
}

pub fn parse_address(a: &str) -> Result<[u8; 20], String> {
    let h = a.strip_prefix("0x").ok_or("address must start with 0x")?;
    if h.len() != 40 {
        return Err("address must be 20 bytes".into());
    }
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).map_err(|_| "bad hex in address")?;
    }
    Ok(out)
}

fn word_addr(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

/// abi.encode(string, uint256, string, uint256)
pub fn encode_leg(give: &str, give_amount: u128, want: &str, min_want: u128) -> Vec<u8> {
    let pad = |n: usize| (n + 31) / 32 * 32;
    let tail = |s: &str| {
        let mut t = word_u128(s.len() as u128).to_vec();
        let mut d = s.as_bytes().to_vec();
        d.resize(pad(s.len()), 0);
        t.extend(d);
        t
    };
    let t1 = tail(give);
    let t2 = tail(want);
    let head_len = 4 * 32;
    let mut out = Vec::new();
    out.extend(word_u128(head_len as u128));
    out.extend(word_u128(give_amount));
    out.extend(word_u128((head_len + t1.len()) as u128));
    out.extend(word_u128(min_want));
    out.extend(t1);
    out.extend(t2);
    out
}

pub fn domain_separator() -> [u8; 32] {
    let mut enc = Vec::new();
    enc.extend(keccak(DOMAIN_TYPE.as_bytes()));
    enc.extend(keccak(DOMAIN_NAME.as_bytes()));
    enc.extend(keccak(DOMAIN_VERSION.as_bytes()));
    enc.extend(word_u128(CHAIN_ID as u128));
    enc.extend([0u8; 32]); // verifyingContract = 0x0
    keccak(&enc)
}

pub fn order_digest(o: &OrderInput) -> Result<[u8; 32], String> {
    let user = parse_address(&o.user)?;
    let order_data = encode_leg(&o.give, o.give_amount.0, &o.want, o.min_want_amount.0);
    let mut enc = Vec::new();
    enc.extend(keccak(ORDER_TYPE.as_bytes()));
    enc.extend(word_addr(&[0u8; 20])); // originSettler
    enc.extend(word_addr(&user));
    enc.extend(word_u128(o.nonce.0));
    enc.extend(word_u128(CHAIN_ID as u128)); // originChainId
    enc.extend(word_u128(o.open_deadline as u128));
    enc.extend(word_u128(o.fill_deadline as u128));
    enc.extend(keccak(LEG_TYPE.as_bytes())); // orderDataType
    enc.extend(keccak(&order_data));
    let hash_struct = keccak(&enc);
    let mut msg = vec![0x19, 0x01];
    msg.extend(domain_separator());
    msg.extend(hash_struct);
    Ok(keccak(&msg))
}

pub fn parse_sig(sig: &str) -> Result<([u8; 64], u8), String> {
    let h = sig.strip_prefix("0x").unwrap_or(sig);
    if h.len() != 130 {
        return Err("signature must be 65 bytes (r || s || v)".into());
    }
    let mut b = [0u8; 65];
    for i in 0..65 {
        b[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).map_err(|_| "bad hex in signature")?;
    }
    let v = match b[64] {
        27 | 28 => b[64] - 27,
        0 | 1 => b[64],
        other => return Err(format!("bad v {other}")),
    };
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&b[..64]);
    Ok((rs, v))
}

/// Recovers the 0x address that signed `digest`.
pub fn recover(digest: &[u8; 32], sig: &str) -> Result<String, String> {
    let (rs, v) = parse_sig(sig)?;
    let pk = env::ecrecover(digest, &rs, v, true).ok_or("ecrecover failed")?;
    let h = keccak(&pk);
    Ok(format!("0x{}", h[12..].iter().map(|x| format!("{x:02x}")).collect::<String>()))
}
