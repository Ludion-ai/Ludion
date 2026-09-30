// DIV-2 (docs/MISSION.md §4): the Card is right. What `ludion init` writes is a CIMD Signature
// Agent Card that Cloudflare's parser (web-bot-auth `parseSignatureAgentCard`, the reference
// implementation from cloudflare/web-bot-auth) accepts; client_id is its own URL; jwks_uri
// resolves; the directory is served as application/http-message-signatures-directory+json;
// and a Gate resolving the card end to end gets VERIFIED. TLS is the one thing not exercised:
// https URLs are routed to a local Card Host with the right Host header.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSignatureAgentCard } from "web-bot-auth";
import { createGate, generateSiteKey } from "@ludion/gate-core";
import { createDiverSigner } from "@ludion/diver";
import { createCardHost, nodeListener, DIRECTORY_MEDIA_TYPE, DIRECTORY_PATH } from "@ludion/card-host";

const CLI = fileURLToPath(new URL("../../diver/bin/ludion.mjs", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-div2-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
execFileSync(process.execPath, [CLI, "init", "--name", "DIV-2 Agent", "--contact", "mailto:ops@example.test"], { cwd: tmp, encoding: "utf8" });
const store = JSON.parse(fs.readFileSync(path.join(tmp, "ludion.json"), "utf8"));
const card = JSON.parse(fs.readFileSync(path.join(tmp, "card"), "utf8"));
const directory = JSON.parse(fs.readFileSync(path.join(tmp, ".well-known", "http-message-signatures-directory"), "utf8"));
const origin = store.signature_agent;
const host = new URL(origin).hostname;
const CARD_URL = `${origin}/card`;

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];
function privateMembers(x, at = "$") {
  if (!x || typeof x !== "object") return [];
  const here = "kty" in x ? PRIVATE_MEMBERS.filter((m) => m in x).map((m) => `${at}.${m}`) : [];
  return [...here, ...Object.entries(x).flatMap(([k, v]) => privateMembers(v, `${at}.${k}`))];
}

// The Card Host, serving exactly the files the CLI wrote, on 127.0.0.1.
const cardHost = createCardHost({ lookup: (h) => (h === host ? { directory, card } : undefined) });
const srv = http.createServer(nodeListener(cardHost));
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
after(() => srv.close());
const port = srv.address().port;

/** fetch for the Gate's resolver: https://<host>/<path> → the local Card Host, Host preserved. Logs what it saw. */
const seen = [];
function localFetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(String(input));
    const req = http.request({ host: "127.0.0.1", port, path: u.pathname + u.search, method: init.method ?? "GET",
      headers: { ...Object.fromEntries(new Headers(init.headers ?? {})), host: u.host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        seen.push({ url: u.href, status: res.statusCode, type: res.headers["content-type"] });
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: Object.entries(res.headers).map(([k, v]) => [k, String(v)]) }));
      });
    });
    init.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
    req.on("error", reject);
    req.end();
  });
}
const get = (p, h = host, method = "GET") => localFetch(`https://${h}${p}`, { method });

test("DIV-2: the card `ludion init` writes passes Cloudflare's Signature Agent Card parser with its own URL", () => {
  const parsed = parseSignatureAgentCard(card, CARD_URL);
  assert.equal(parsed.client_id, CARD_URL, "client_id == the URL the card is published at");
  assert.equal(parsed.jwks_uri, `${origin}${DIRECTORY_PATH}`);
  assert.ok(["fetcher", "crawler"].includes(parsed.web_bot_auth?.trigger), "web_bot_auth.trigger");
  assert.equal(parsed.client_name, "DIV-2 Agent");
  assert.deepEqual(parsed.contacts, ["mailto:ops@example.test"]);
  assert.throws(() => parseSignatureAgentCard(card, `${origin}/elsewhere`), /client_id/, "the parser binds client_id to the URL");
});

test("DIV-2: the card is a strict CIMD document and carries Ludion data in one object", () => {
  const id = new URL(card.client_id);
  assert.equal(id.protocol, "https:");
  assert.ok(id.pathname.length > 1, "client_id has a path");
  assert.equal(id.hash, ""); assert.equal(id.search, "");
  assert.ok(!id.pathname.split("/").some((s) => s === "." || s === ".."), "no dot segments");
  for (const k of ["client_secret", "client_secret_expires_at"]) assert.ok(!(k in card), `no ${k}`);
  if (card.token_endpoint_auth_method) assert.doesNotMatch(card.token_endpoint_auth_method, /^client_secret/);
  assert.equal(new URL(card.jwks_uri).origin, id.origin, "jwks_uri on the card's own origin");
  assert.ok(!(card.jwks && card.jwks_uri), "jwks or jwks_uri, not both");
  assert.equal(card.ludion?.diver_id, store.diver_id);
  assert.match(store.diver_id, /^dvr-[a-z2-7]{16}$/);
  assert.equal(host, `${store.diver_id}.agents.ludion.ai`);
  const unknownTop = Object.keys(card).filter((k) => !["client_id", "client_name", "client_uri", "logo_uri", "contacts", "jwks_uri", "jwks", "ips_uri", "web_bot_auth", "ludion"].includes(k));
  assert.deepEqual(unknownTop, [], "Ludion-specific fields live only under `ludion`");
  assert.deepEqual(privateMembers(card), [], "no private key members anywhere in the card");
});

test("DIV-2: the directory is served as application/http-message-signatures-directory+json, 200, no redirect, session key only", async () => {
  const r = await get(DIRECTORY_PATH);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), DIRECTORY_MEDIA_TYPE);
  assert.match(r.headers.get("cache-control") ?? "", /max-age=\d+/);
  const body = await r.json();
  assert.deepEqual(body.keys.map((k) => k.kid), [store.session.kid], "exactly the session key");
  assert.ok(!body.keys.some((k) => k.kid === store.root.kid), "Root key is not in the directory");
  assert.deepEqual(privateMembers(body), []);
  const c = await get("/card");
  assert.equal(c.status, 200);
  assert.match(c.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await c.json(), card);
});

test("DIV-2: a Gate resolves the card end to end (type=cimd → card → jwks_uri → directory) to VERIFIED", async () => {
  const siteKey = await generateSiteKey();
  const gate = await createGate({ siteId: "site-div2", siteKey: siteKey.privateJwk, resolver: { fetch: localFetch } });
  seen.length = 0;
  const signer = await createDiverSigner({ sessionPrivateJwk: store.session, signatureAgent: store.signature_agent, cimd: true });
  const headers = await signer.headersFor({ method: "GET", url: "https://shop.example/products", headers: {} });
  const r = await gate.inspect({ kind: "request", method: "GET", targetUri: "https://shop.example/products", fields: Object.entries(headers).map(([name, value]) => ({ name, value })) });
  assert.equal(r.cls.class, "VERIFIED", JSON.stringify(r.cls));
  assert.equal(r.cls.identifier, CARD_URL, "identified by the card URL");
  assert.equal(r.cls.card?.client_id, CARD_URL);
  assert.deepEqual(seen.map((s) => s.url), [CARD_URL, `${origin}${DIRECTORY_PATH}`], "fetched the card, then its jwks_uri");
  assert.equal(seen[1].type, DIRECTORY_MEDIA_TYPE);

  const plain = await createDiverSigner({ sessionPrivateJwk: store.session, signatureAgent: store.signature_agent });
  const h2 = await plain.headersFor({ method: "GET", url: "https://shop.example/", headers: {} });
  const r2 = await gate.inspect({ kind: "request", method: "GET", targetUri: "https://shop.example/", fields: Object.entries(h2).map(([name, value]) => ({ name, value })) });
  assert.equal(r2.cls.class, "VERIFIED", JSON.stringify(r2.cls));
  assert.equal(r2.cls.identifier, `${origin}${DIRECTORY_PATH}`, "directory discovery resolves the same key");
});

test("DIV-2: the Card Host refuses what a parser would reject and never leaks private members", async () => {
  const leaky = createCardHost({ lookup: () => ({
    directory: { keys: [{ ...store.session, use: "sig" }, { kty: "RSA", n: "AQAB", e: "AQAB", d: "secret", p: "x", q: "y" }] },
    card: { ...card, client_id: "https://someone-else.example/card" },
  }) });
  const d = await (await leaky.fetch(new Request(`https://${host}${DIRECTORY_PATH}`))).json();
  assert.deepEqual(privateMembers(d), [], "private members dropped even when handed a private JWK");
  assert.equal(d.keys[0].x, store.session.x);
  assert.equal((await leaky.fetch(new Request(`https://${host}/card`))).status, 500, "card whose client_id is not its URL is not served");
  const inline = createCardHost({ lookup: () => ({ directory, card: { client_id: `https://${host}/card`, jwks: { keys: [store.root] } } }) });
  assert.deepEqual(privateMembers(await (await inline.fetch(new Request(`https://${host}/card`))).json()), [], "inline jwks is public-only too");
  assert.equal((await get(DIRECTORY_PATH, "unknown.agents.ludion.ai")).status, 404);
  assert.equal((await get("/admin")).status, 404);
  assert.equal((await get("/card", host, "POST")).status, 405);
  const head = await get(DIRECTORY_PATH, host, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), DIRECTORY_MEDIA_TYPE);
  for (const p of [DIRECTORY_PATH, "/card", "/", "/card/", "/.well-known/"]) {
    const s = (await get(p)).status;
    assert.ok(s < 300 || s >= 400, `${p}: never a redirect (${s})`);
  }
});
