import type { NomadState, TokenId, TokenMeta } from "./types";

// Categorical slots (dark steps), assigned to tokens in fixed order, never cycled.
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];
export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };

export type TokenIndex = Map<TokenId, TokenMeta & { color: string }>;

export function tokenIndexOf(tokens: TokenMeta[]): TokenIndex {
  const m: TokenIndex = new Map();
  tokens.forEach((t, i) => m.set(t.id, { ...t, color: SERIES[Math.min(i, SERIES.length - 1)] }));
  return m;
}

export function tokenIndex(state: NomadState): TokenIndex {
  return tokenIndexOf(state.meta.tokens);
}

export function sym(ix: TokenIndex, id: TokenId): string {
  return ix.get(id)?.symbol ?? id.replace(/^nep141:/, "").split(".")[0];
}

export function tokenColor(ix: TokenIndex, id: TokenId): string {
  return ix.get(id)?.color ?? "#898781";
}

/** Smallest-unit string -> number in whole tokens (display only). */
export function toUnits(ix: TokenIndex, id: TokenId, amt: string): number {
  const d = ix.get(id)?.decimals ?? 0;
  try {
    const v = BigInt(amt);
    const neg = v < 0n;
    const a = neg ? -v : v;
    const base = 10n ** BigInt(d);
    const n = Number(a / base) + Number(a % base) / Number(base);
    return neg ? -n : n;
  } catch {
    return Number(amt) / 10 ** d;
  }
}

export function fmtNum(n: number): string {
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 20 });
}

export function fmtAmt(ix: TokenIndex, id: TokenId, amt: string): string {
  return `${fmtNum(toUnits(ix, id, amt))} ${sym(ix, id)}`;
}

/**
 * Amount in whole tokens without rounding ("0.999999 USDT"). Long fractions (24-decimal wNEAR) are cut
 * to `sig` significant digits and marked with "…"; never rounded, so a 1-unit fee stays visible.
 */
export function fmtAmtExact(ix: TokenIndex, id: TokenId, amt: string, sig = 8): string {
  const d = ix.get(id)?.decimals ?? 0;
  const v = BigInt(amt);
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(d + 1, "0");
  const whole = a.slice(0, a.length - d);
  let frac = d ? a.slice(a.length - d).replace(/0+$/, "") : "";
  const lead = frac.length - frac.replace(/^0+/, "").length;
  const keep = whole === "0" ? lead + sig : Math.max(0, sig - whole.length);
  const cut = frac.length > keep;
  if (cut) frac = frac.slice(0, keep).replace(/0+$/, "");
  return `${neg ? "-" : ""}${BigInt(whole).toLocaleString("en-US")}${frac ? "." + frac : ""}${cut ? "…" : ""} ${sym(ix, id)}`;
}

export function shortAgent(id: string): string {
  return id.split(".")[0];
}

export function shortHash(h: string, n = 6): string {
  return h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h;
}

export function fmtBps(b: number | null | undefined, digits = 1): string {
  return b == null ? "—" : `${b.toFixed(digits)} bps`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
