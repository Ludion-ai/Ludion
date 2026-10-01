// Content-Digest (RFC 9530) held to the body that actually arrived (spec §10.4, GATE-11).
//
// A state-changing request signs its Content-Digest; the signature then binds the body only if the
// verifier checks that digest against the bytes it received (RFC 9421 §7.2.8). The Gate reads the
// body for that and nothing else: it is hashed here and never leaves the site (spec §8.6, §11.7).
// Adapters hand the bytes over on the request descriptor (`req.body`) when bodyNeeded() says a
// signature covers content-digest; a body they could not read is `{ unavailable: "<reason>" }`.
//
// Runtime-neutral: WebCrypto digest (hashing, not a signature primitive: CRY-1) and Web Streams.

/** RFC 9530 §5's active algorithms. The deprecated ones (md5, sha, unixsum, …) are not checked. */
const ALGORITHMS = { "sha-256": "SHA-256", "sha-512": "SHA-512" };

/** The most body bytes an adapter buffers to check a digest; a larger body is not checked (and so not VERIFIED). */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** How long an adapter waits for the rest of a body it is checking. */
export const DEFAULT_BODY_TIMEOUT_MS = 15_000;

/**
 * Does a signature on this request cover content-digest? Conservative and cheap (no parsing): an
 * adapter that sees true reads the body for the Gate; one that sees false never touches it.
 * @param {{ fields: { name: string, value: string }[] }} req
 */
export function bodyNeeded(req) {
  return req.fields.some((f) => f.name.toLowerCase() === "signature-input" && /"content-digest"/i.test(f.value));
}

// One dictionary member (RFC 8941): key=:byte sequence:, parameters allowed and ignored.
const MEMBER = /^([a-z*][a-z0-9_.*-]*)=:([A-Za-z0-9+/]*={0,2}):((?:;[a-z*][a-z0-9_.*-]*(?:=[^;,]*)?)*)$/;

/** @returns {{ alg: string, value: Uint8Array }[] | null} null when it is not a well-formed digest dictionary */
export function parseContentDigest(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const out = [];
  for (const raw of value.split(",")) {
    const m = MEMBER.exec(raw.trim());
    if (!m) return null;
    let bytes;
    try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { return null; }
    out.push({ alg: m[1], value: bytes });
  }
  return out;
}

function bytesOf(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

/**
 * Check a Content-Digest field value against the body. Every algorithm the Gate implements must
 * match; one that matches never excuses one that does not.
 * @param {string|undefined} value  the Content-Digest field (combined, as RFC 9421 sees it)
 * @param {Uint8Array|ArrayBuffer|string} body
 * @returns {Promise<"match"|"mismatch"|"unsupported"|"malformed">}
 */
export async function checkContentDigest(value, body) {
  const members = parseContentDigest(value);
  const bytes = bytesOf(body);
  if (!members || !bytes) return "malformed";
  const known = members.filter((m) => ALGORITHMS[m.alg]);
  if (!known.length) return "unsupported";
  for (const m of known) {
    const got = new Uint8Array(await crypto.subtle.digest(ALGORITHMS[m.alg], bytes));
    if (got.length !== m.value.length || got.some((b, i) => b !== m.value[i])) return "mismatch";
  }
  return "match";
}

/**
 * The body of a Web Request (Workers, Next.js), for the Gate to check, without consuming it: a
 * clone is read, so the handler still gets every byte. At most `maxBytes`; never throws.
 * @param {Request} request
 * @returns {Promise<Uint8Array | { unavailable: string }>}
 */
export async function readWebBody(request, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  try {
    if (request.bodyUsed) return { unavailable: "body_consumed" };
    if (!request.body) return new Uint8Array(0);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return { unavailable: "body_too_large" };
    const reader = request.clone().body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) { reader.cancel().catch(() => {}); return { unavailable: "body_too_large" }; }
      chunks.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  } catch {
    return { unavailable: "body_error" };
  }
}
