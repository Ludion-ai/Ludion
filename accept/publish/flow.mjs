// PUB-1, inside the clean install: only the published package names are importable here (no
// monorepo, no workspace links). My agent → my Gate → VERIFIED through each adapter's entry point.
// Everything on 127.0.0.1. Prints "ok …" per check; exits 1 at the first failure.
import http from "node:http";
import { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, createDiverSigner, ludionFetch, DIRECTORY_MEDIA_TYPE } from "@ludion/diver";
import { generateSiteKey } from "@ludion/gate-core";
import { ludionGate } from "@ludion/gate-node";
import { withLudion } from "@ludion/gate-workers";
import { createNextGate } from "@ludion/gate-next/core";

const check = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok", msg); };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const ludionHeaders = (h) => [...h.keys()].filter((k) => k.toLowerCase().startsWith("ludion-"));

// Diver: a Root, a Session key, and a Card Host serving the directory and the Card.
const root = await generateEd25519(), session = await generateEd25519();
let agentOrigin;
const cardHost = http.createServer((req, res) => {
  if (req.url === "/.well-known/http-message-signatures-directory") {
    res.writeHead(200, { "content-type": DIRECTORY_MEDIA_TYPE }); return res.end(JSON.stringify(directoryDocument([session.publicJwk])));
  }
  if (req.url === "/card") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(cardDocument({ origin: agentOrigin, name: "PUB-1", contacts: ["mailto:ops@example.test"], ludion: { diver_id: diverIdFromRoot(root.publicJwk) } })));
  }
  res.writeHead(404); res.end();
});
agentOrigin = `http://127.0.0.1:${await listen(cardHost)}`;

// @ludion/gate-node: a real server, Pressure 0 with a Pressure-2 checkout.
const siteKey = await generateSiteKey();
let authority;
const mw = await ludionGate({ siteId: "site-pub1", siteKey: siteKey.privateJwk, pressure: 0, authorities: (a) => a === authority,
  routes: [{ match: "/checkout/**", pressure: 2 }], resolver: { insecureAllowHttp: true, allowPrivateNetwork: true } });
const site = http.createServer((req, res) => mw(req, res, () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ class: req.ludion.cls.class })); }));
authority = `127.0.0.1:${await listen(site)}`;
const siteUrl = `http://${authority}`;

let r = await fetch(`${siteUrl}/`, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" } });
check(r.status === 200 && (await r.json()).class === "UNKNOWN" && !!r.headers.get("ludion-receipt"), "gate-node: a browser is UNKNOWN, served, with a receipt");
r = await fetch(`${siteUrl}/checkout/1`, { headers: { "user-agent": "python-requests/2.32" } });
check(r.status === 401 && r.headers.get("ludion-error") === "signature_required", "gate-node: unsigned automation on a Pressure-2 route is asked to sign");
const signer = await createDiverSigner({ sessionPrivateJwk: session.privateJwk, signatureAgent: agentOrigin, insecureAllowHttp: true });
r = await ludionFetch(`${siteUrl}/products`, {}, { signer });
check(r.status === 200 && (await r.json()).class === "VERIFIED", "diver → gate-node: a signed request is VERIFIED");

// @ludion/gate-workers: the wrapped fetch handler, config from the LUDION var.
const worker = withLudion({ async fetch() { return new Response("ok", { headers: { "content-type": "text/plain" } }); } });
const wr = await worker.fetch(new Request("https://shop.example/", { headers: { "user-agent": "Mozilla/5.0 Chrome/141.0" } }),
  { LUDION: JSON.stringify({ site_id: "site-pub1-workers", pressure: 0 }) }, { waitUntil() {}, passThroughOnException() {} });
check(wr.status === 200 && (await wr.text()) === "ok" && ludionHeaders(wr.headers).length > 0, "gate-workers: the app's response, with Ludion headers");

// @ludion/gate-next: the proxy core, config handed in (no Next.js needed to load it).
const { proxy } = createNextGate({ next: () => new Response(null, { headers: { "x-middleware-next": "1" } }),
  loadConfig: async () => ({ site_id: "site-pub1-next", pressure: 0 }), env: {} });
const nr = await proxy(new Request("https://shop.example/", { headers: { "user-agent": "Mozilla/5.0 Chrome/141.0" } }));
check(nr.headers.get("x-middleware-next") === "1" && ludionHeaders(nr.headers).length > 0, "gate-next: continues to the app, with Ludion headers");

cardHost.close(); site.close();
console.log("ok flow complete");
