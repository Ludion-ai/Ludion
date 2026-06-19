/**
 * Session + cookie helpers — Workspace 2a.
 *
 * The session is a stateless HMAC-SHA256-signed token carrying only the GitHub
 * user id, the handle (for display), and issue/expiry timestamps. No GitHub
 * access token, no secret, no content. Signed and verified with `SESSION_SECRET`
 * (a Pages secret). `crypto.subtle.verify` is constant-time.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Session cookie name (httpOnly). */
export const SESSION_COOKIE = "ludion_session";
/** Short-lived OAuth CSRF state cookie name (httpOnly). */
export const OAUTH_STATE_COOKIE = "ludion_oauth_state";
/** Session lifetime: 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Session {
  /** Stable GitHub user id (string form). */
  uid: string;
  /** GitHub handle, for display only. */
  login: string;
  /** Issued-at (ms epoch). */
  iat: number;
  /** Expiry (ms epoch). */
  exp: number;
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Sign a session payload into a `<body>.<sig>` token. */
export async function signSession(payload: Session, secret: string): Promise<string> {
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64urlFromBytes(sig)}`;
}

/** Verify a token's signature and expiry. Returns the session, or null. */
export async function verifySession(
  token: string,
  secret: string,
  nowMs: number,
): Promise<Session | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  let sigBytes: Uint8Array;
  try {
    sigBytes = bytesFromB64url(sigPart);
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes as BufferSource, enc.encode(body));
  if (!ok) return null;
  let payload: Session;
  try {
    payload = JSON.parse(dec.decode(bytesFromB64url(body))) as Session;
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < nowMs) return null;
  if (typeof payload.uid !== "string" || typeof payload.login !== "string") return null;
  return payload;
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k.length > 0) out[k] = decodeURIComponent(v);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  /** Default true; tests pass false to read back values without the Secure gate. */
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

/** Serialize a Set-Cookie value. Always HttpOnly (no script access). */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  parts.push("HttpOnly");
  if (opts.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}
