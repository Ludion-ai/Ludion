// Signed cookies: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET)).
// Signatures are checked with crypto.subtle.verify, which compares in constant time.

export interface Session {
  login: string;
  id: number;
  avatar_url: string;
  /** Unix seconds. */
  exp: number;
}

export const SESSION_COOKIE = "ludion_session";
export const OAUTH_COOKIE = "ludion_oauth";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const OAUTH_SECONDS = 10 * 60;

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    // SESSION_SECRET is 32+ random bytes, base64. Fall back to the raw text if it is not base64.
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(secret);
    } catch {
      bytes = encoder.encode(secret);
    }
    key = crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, key);
  }
  return key;
}

export async function sign(payload: object, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return `${body}.${base64url(mac)}`;
}

/** The payload if the signature is valid and `exp` (Unix seconds) has not passed; otherwise undefined. */
export async function verify<T extends { exp: number }>(token: string | undefined, secret: string, nowSeconds: number): Promise<T | undefined> {
  if (!token) return undefined;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return undefined;
  const body = token.slice(0, dot);
  let mac: Uint8Array;
  try {
    mac = fromBase64url(token.slice(dot + 1));
  } catch {
    return undefined;
  }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, encoder.encode(body));
  if (!ok) return undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
    return typeof payload.exp === "number" && payload.exp > nowSeconds ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time string comparison, for OAuth state. */
export function sameText(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
