// Phase 0 exit criterion (spec §16): my agent → my Gate → VERIFIED.
// Everything runs on 127.0.0.1. No network. `node examples/e2e.mjs`
import http from "node:http";
import { createGate, generateSiteKey, issueStaple } from "@ludion/gate-core";
import { ludionGate } from "@ludion/gate-node";
import { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, createDiverSigner, ludionFetch, DIRECTORY_MEDIA_TYPE } from "@ludion/diver";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const check = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); };

// 1. Diver: Root (identity) + Session (exposure)
const root = await generateEd25519();
const session = await generateEd25519();
const diverId = diverIdFromRoot(root.publicJwk);

// 2. Card Host (what *.agents.ludion.ai will serve). Session keys only.
const cardHost = http.createServer((req, res) => {
  if (req.url === "/.well-known/http-message-signatures-directory") {
    res.writeHead(200, { "content-type": DIRECTORY_MEDIA_TYPE, "cache-control": "max-age=3600" });
    return res.end(JSON.stringify(directoryDocument([session.publicJwk])));
  }
  if (req.url === "/card") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(cardDocument({ origin: agentOrigin, name: "E2E Diver", contacts: ["mailto:ops@example.test"],
      webBotAuth: { purpose: "search" }, ludion: { diver_id: diverId, registry: "https://registry.ludion.ai" } })));
  }
  res.writeHead(404); res.end();
});
const cardPort = await listen(cardHost);
const agentOrigin = `http://127.0.0.1:${cardPort}`;

// 3. A local "Registry" that issues a Staple bound to the session key
const registry = await generateEd25519();
const registryPriv = await crypto.subtle.importKey("jwk", registry.privateJwk, { name: "Ed25519" }, false, ["sign"]);
const nowS = Math.floor(Date.now() / 1000);
const staple = await issueStaple(registryPriv, registry.kid, {
  iss: "https://registry.ludion.ai", sub: diverId, iat: nowS, exp: nowS + 3600, depth: 2,
  ballast: { status: "active", tier: "b0", commitments: ["abuse_response_24h", "revocation_consent", "glass_consent"] },
  op: { verified: "email", jurisdiction: "JP" }, cnf: { jkt: [session.kid] },
});

// 4. The site, with a Gate: observe everywhere, gate /checkout
const siteKey = await generateSiteKey();
const events = [];
let siteAuthority; // the site's own host:port (ADR-023), known once it listens
const gate = await ludionGate({
  siteId: "site-e2e", siteKey: siteKey.privateJwk, pressure: 0, authorities: (a) => a === siteAuthority,
  routes: [{ match: "/checkout/**", pressure: 2, require: { depth: 1, ballast: "active" } }],
  registryKeys: { keys: [registry.publicJwk] },
  resolver: { insecureAllowHttp: true, allowPrivateNetwork: true },
  sink: (e) => events.push(e),
});
const site = http.createServer((req, res) => gate(req, res, () => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ class: req.ludion.cls.class, depth: req.ludion.cls.depth ?? null, diver: req.ludion.cls.diverId ?? null }));
}));
const sitePort = await listen(site);
siteAuthority = `127.0.0.1:${sitePort}`;
const siteUrl = `http://${siteAuthority}`;

// 5. Requests
let r = await fetch(`${siteUrl}/`, { headers: { "user-agent": "Mozilla/5.0 (human)" } });
check(r.status === 200 && (await r.json()).class === "UNKNOWN", "human: UNKNOWN, allowed, untouched");

r = await fetch(`${siteUrl}/checkout/123`, { headers: { "user-agent": "python-requests/2.32" } });
check(r.status === 401 && r.headers.get("ludion-error") === "signature_required" && /ludion\.ai\/e\//.test(r.headers.get("link") ?? ""),
  "unsigned automation on /checkout at Pressure 2: 401 signature_required + help link (rejection is sales)");
check(r.headers.get("accept-signature")?.includes("web-bot-auth"), "401 carries Accept-Signature (draft §5.3)");

const signer = await createDiverSigner({ sessionPrivateJwk: session.privateJwk, signatureAgent: agentOrigin, insecureAllowHttp: true });
r = await ludionFetch(`${siteUrl}/api/search?q=camera`, {}, { signer });
let body = await r.json();
check(r.status === 200 && body.class === "VERIFIED" && body.depth === 0, "signed GET without Staple: VERIFIED(depth=0) — existing Web Bot Auth signers are supply from day one");
check(!!r.headers.get("ludion-receipt"), "Glass receipt returned to the agent");

r = await ludionFetch(`${siteUrl}/checkout/123`, { method: "POST", body: JSON.stringify({ sku: 1 }), headers: { "content-type": "application/json" } }, { signer });
check(r.status === 403 && r.headers.get("ludion-error") === "depth_insufficient", "signed POST /checkout without Staple: 403 depth_insufficient (D0 < required D1)");

const stapled = await createDiverSigner({ sessionPrivateJwk: session.privateJwk, signatureAgent: agentOrigin, insecureAllowHttp: true, staple: () => staple });
r = await ludionFetch(`${siteUrl}/checkout/123`, { method: "POST", body: JSON.stringify({ sku: 1 }), headers: { "content-type": "application/json" } }, { signer: stapled });
body = await r.json();
check(r.status === 200 && body.class === "VERIFIED" && body.depth === 2 && body.diver === diverId, `signed POST /checkout with Staple: VERIFIED depth=2 ballast=active diver=${diverId}`);

// Replay: resend the exact same signed headers → rejected
const hdrs = await stapled.headersFor({ method: "GET", url: `${siteUrl}/api/search`, headers: {} });
r = await fetch(`${siteUrl}/api/search`, { headers: hdrs }); check((await r.json()).class === "VERIFIED", "fresh signed GET: VERIFIED");
r = await fetch(`${siteUrl}/api/search`, { headers: hdrs }); check((await r.json()).class === "SPOOFED", "replayed signature: SPOOFED (nonce reuse)");

// Tamper: another agent's staple is not bound to this key
const other = await generateEd25519();
const otherSigner = await createDiverSigner({ sessionPrivateJwk: other.privateJwk, signatureAgent: agentOrigin, insecureAllowHttp: true, staple: () => staple });
r = await fetch(`${siteUrl}/api/search`, { headers: await otherSigner.headersFor({ method: "GET", url: `${siteUrl}/api/search`, headers: {} }) });
check((await r.json()).class === "UNVERIFIED", "key not in the agent's directory: UNVERIFIED (not attributable, not SPOOFED)");

// Swap the staple out from under a valid signature → invalid (staple is covered)
const good = await stapled.headersFor({ method: "GET", url: `${siteUrl}/api/search`, headers: {} });
// Always a real change: a fixed "AA" was a no-op whenever the Staple already ended in "AA" (1 in 256).
r = await fetch(`${siteUrl}/api/search`, { headers: { ...good, "ludion-staple": staple.slice(0, -2) + (staple.endsWith("AA") ? "QA" : "AA") } });
check((await r.json()).class === "SPOOFED", "swapped Staple under a valid signature: SPOOFED");

// What leaves the Gate is hourly counts (ADR-038): close the hour, then look at everything sent.
gate.gate.flush({ all: true });
const rows = events.flatMap((b) => b.rows ?? []);
const ROW = "class,count,decision,method,operator,route";
check(events.length >= 1 && events.every((b) => b.kind === "ludion.hourly" && Object.keys(b).sort().join() === "hour,kind,rows,site,v")
  && rows.reduce((n, x) => n + x.count, 0) >= 6 && rows.every((x) => Object.keys(x).sort().join() === ROW && x.route && !/\d{3}/.test(x.route)),
  `metadata sink received ${events.length} hourly batch(es), ${rows.reduce((n, x) => n + x.count, 0)} visits counted: route templates only, no visit, no content, no raw IP`);
console.log("\nsample row:", JSON.stringify(rows.find((x) => x.class === "VERIFIED" && x.operator === diverId)));

cardHost.close(); site.close();
console.log("\nPHASE 0 EXIT: my agent → my Gate → VERIFIED ✔");
