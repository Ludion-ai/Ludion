// PRIV-1/PRIV-2 workload, run under ./trap.mjs. N requests of every class through the real
// @ludion/gate-node middleware (synthetic IncomingMessage objects: no sockets, so any socket use
// is the Gate's own and is caught). Each request plants unique canaries in the body, cookies,
// query values, a path segment, the Host (unsigned only) and every non-signature header value,
// and raw client IPs (socket address, X-Forwarded-For and friends). The class tally, the planted
// IPs and the canary prefix go to __egress.meta, which is not egress.
//   env: PRIV_N, PRIV_TRUST_PROXY=1, PRIV_SEND_METADATA=1|0|unset, PRIV_SINK=1
import { Readable } from "node:stream";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey } from "@ludion/gate-core";
import { keypair, signed, staple, digestOf, AGENT, NOW_MS, REGISTRY_ISS } from "../../../gate-core/test/support.mjs";

const N = Number(process.env.PRIV_N ?? 10_000);
const TRUST_PROXY = process.env.PRIV_TRUST_PROXY === "1";
const SEND = process.env.PRIV_SEND_METADATA === undefined ? undefined : process.env.PRIV_SEND_METADATA === "1";
const egress = globalThis.__egress;

const [agent, stranger, registry, cimdKey, jwksKey] = await Promise.all([keypair(), keypair(), keypair(), keypair(), keypair()]);
// Every way the protocol discovers keys: a directory, a CIMD Card and its jwks_uri, a bare jwks_uri.
const CARD = "https://cimd.example/card", CARD_KEYS = "https://cimd.example/keys.json", JWKS = "https://jwks.example/keys.json";
const DIRECTORY = `${AGENT}/.well-known/http-message-signatures-directory`;
egress.docs.set(DIRECTORY, { body: { keys: [{ ...agent.publicJwk, use: "sig" }] }, type: "application/http-message-signatures-directory+json" });
egress.docs.set(CARD, { body: { client_id: CARD, client_name: "Card agent", jwks_uri: CARD_KEYS } });
egress.docs.set(CARD_KEYS, { body: { keys: [{ ...cimdKey.publicJwk, use: "sig" }] } });
egress.docs.set(JWKS, { body: { keys: [{ ...jwksKey.publicJwk, use: "sig" }] } });
egress.meta("discovery", { directory: [DIRECTORY, "https://stranger.example/.well-known/http-message-signatures-directory"], card: [CARD], jwks: [CARD_KEYS, JWKS] });

const siteKey = await generateSiteKey();
const mw = await ludionGate({
  siteId: "site-priv", siteKey: siteKey.privateJwk, pressure: 0, now: () => NOW_MS, trustProxy: TRUST_PROXY,
  routes: [{ match: "/checkout/**", pressure: 2 }, { match: "/login", pressure: 2, require: { depth: 1 } }, { match: "/search", pressure: 1 }],
  registryKeys: { keys: [registry.publicJwk] }, registryIssuer: REGISTRY_ISS,
  ...(process.env.PRIV_SINK === "0" ? {} : { sink: (e) => egress.record({ ch: "sink", data: e }) }),
  ...(SEND === undefined ? {} : { sendMetadata: SEND }),
});

// ── canaries and IPs ───────────────────────────────────────────────────────────────────────
const PREFIX = "ludioncanary";
const letters = (n) => { let s = ""; do { s += String.fromCharCode(97 + (n % 26)); n = Math.floor(n / 26); } while (n); return s; };
/** Unique per request and place. Letters only where a digit would already be templated away. */
const canary = (i, place) => `${PREFIX}${letters(i)}${place}`;
const planted = new Set();
const ip4 = (i) => { const a = [`198.51.100.${i % 250 + 1}`, `203.0.113.${(i * 7) % 250 + 1}`][i % 2]; planted.add(a); return a; };
const ip6 = (i) => { const a = `2001:db8:${(i % 65000).toString(16)}:${((i * 13) % 65000).toString(16)}::${(i % 250 + 1).toString(16)}`; planted.add(a); return a; };

const UAS = {
  UNKNOWN: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
  DECLARED: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  SUSPECTED: "python-requests/2.32.3",
};
const KINDS = ["UNKNOWN", "DECLARED", "SUSPECTED", "VERIFIED", "VERIFIED_STAPLED", "UNVERIFIED", "SPOOFED", "SPOOFED_UNSIGNED", "REVOKED", "REPLAY", "VERIFIED_CIMD", "VERIFIED_JWKS"];
const SIGNED = new Set(["VERIFIED", "VERIFIED_STAPLED", "REVOKED", "UNVERIFIED", "SPOOFED", "REPLAY", "VERIFIED_CIMD", "VERIFIED_JWKS"]);
const signerOf = (kind) => ({
  UNVERIFIED: { key: stranger, agent: "https://stranger.example" },
  VERIFIED_CIMD: { key: cimdKey, agentHeader: `sig1="${CARD}";type=cimd` },
  VERIFIED_JWKS: { key: jwksKey, agentHeader: `sig1="${JWKS}";type=jwks_uri` },
}[kind] ?? { key: agent, agent: AGENT });
const PATHS = ["/", "/checkout/:c", "/login", "/search", "/p/:c", "/account/:c/orders"];
const HOST = "shop.example";

const stapleOk = await staple(registry, { jkt: agent.kid, depth: 2 });
const stapleRevoked = await staple(registry, { jkt: agent.kid, depth: 2, revoked: true });
let replayOf = null;

async function build(i) {
  const kind = KINDS[i % KINDS.length];
  const c = (place) => canary(i, place);
  const path = PATHS[Math.floor(i / KINDS.length) % PATHS.length].replace(":c", c("p"));
  const target = `${path}?q=${c("q")}&id=${c("r")}&utm_source=${c("s")}`;
  const post = i % 3 === 0;
  const method = post ? "POST" : "GET";
  const body = post ? JSON.stringify({ email: `${c("b")}@example.com`, note: c("n") }) : null;
  const clientIp = i % 2 ? ip6(i) : ip4(i);
  const headers = [
    ["Cookie", `sid=${c("k")}; cart=${c("l")}`],
    ["Referer", `https://ref.example/${c("f")}?x=${c("g")}`],
    ["Accept-Language", `en-${c("h")}`],
    ["Authorization", `Bearer ${c("a")}`],
    ["X-Custom", c("x")],
    ["Origin", `https://${c("o")}.example`],
    ["CF-IPCountry", c("y")],
    ["X-Vercel-IP-Country", c("z")],
    ["X-Forwarded-For", `${clientIp}, ${ip4(i + 1)}`],
    ["X-Real-IP", ip6(i + 2)],
    ["Forwarded", `for="[${ip6(i + 3)}]";proto=https;host=${c("w")}.example`],
    ["True-Client-IP", ip4(i + 4)],
    ["CF-Connecting-IP", ip4(i + 5)],
    ["X-Forwarded-Host", `${c("v")}.example`],
  ];
  const url = `http://${HOST}${target}`;
  let sigFields = [];
  if (SIGNED.has(kind)) {
    const stp = kind === "VERIFIED_STAPLED" ? stapleOk : kind === "REVOKED" ? stapleRevoked : null;
    let desc;
    if (kind === "REPLAY" && replayOf) desc = replayOf;
    else {
      desc = await signed({ ...signerOf(kind), url, method, body: body ?? undefined,
        headers: { "user-agent": `ExampleAgent/1.0 (${c("u")})`, ...(stp ? { "ludion-staple": stp } : {}) },
        ...(stp ? { extraComponents: ["ludion-staple"] } : {}) });
      if (kind === "SPOOFED") desc.fields = desc.fields.map((f) => (f.name === "signature" ? { ...f, value: f.value.replace(/.(?=:$)/, (ch) => (ch === "A" ? "B" : "A")) } : f));
      if (kind === "VERIFIED") replayOf = { ...desc, url, target, body, method };
    }
    sigFields = desc.fields.map((f) => [f.name, f.value]);
    // The signed authority is the Host (or, behind a trusted proxy, X-Forwarded-Host): keep it real.
    const signedHeaders = headers.map(([k, v]) => (k === "X-Forwarded-Host" ? [k, HOST] : [k, v]));
    if (kind === "REPLAY") return { kind, method: replayOf.method, target: replayOf.target, body: replayOf.body, headers: [["Host", HOST], ...sigFields, ...signedHeaders], clientIp };
    return { kind, method, target, body, headers: [["Host", HOST], ...sigFields, ...signedHeaders], clientIp };
  }
  const ua = kind === "SPOOFED_UNSIGNED" ? `${UAS.DECLARED} ${c("u")}` : `${UAS[kind]} ${c("u")}`;
  const extra = kind === "SPOOFED_UNSIGNED" ? [["Signature-Agent", `sig1="${AGENT}"`]] : [];
  if (post) headers.push(["Content-Digest", digestOf(body)]);
  return { kind, method, target, body, headers: [["Host", i % 5 ? HOST : `${c("t")}.shop.example`], ["User-Agent", ua], ...extra, ...headers], clientIp };
}

/** A Node IncomingMessage as the http module builds it, with the body still unread. */
function incoming({ method, target, body, headers, clientIp }) {
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  req.method = method; req.url = target; req.httpVersion = "1.1";
  req.rawHeaders = headers.flat();
  req.headers = {};
  for (const [k, v] of headers) { const l = k.toLowerCase(); req.headers[l] = l in req.headers ? `${req.headers[l]}, ${v}` : v; }
  req.socket = { remoteAddress: clientIp, encrypted: false };
  return req;
}
function outgoing() {
  const res = { statusCode: 200, headers: {}, ended: false };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = () => { res.ended = true; };
  return res;
}

const tally = {};
for (let i = 0; i < N; i++) {
  const r = await build(i);
  const req = incoming(r), res = outgoing();
  await new Promise((resolve) => { const p = mw(req, res, resolve); Promise.resolve(p).then(() => res.ended && resolve()); });
  const cls = req.ludion?.cls?.class ?? "NONE";
  const key = `${r.kind}>${cls}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
egress.meta("tally", tally);
egress.meta("prefix", PREFIX);
egress.meta("planted", [...planted]);
egress.meta("n", N);
