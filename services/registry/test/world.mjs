// A small real world for the Registry oracles (REG-1, REG-3, PRIV-3): a Registry process (or an
// in-process server), Divers that register and carry Staples, and sites running the real Node Gate.
// Every key here is a throwaway made for the test in the OS temp dir; nothing is a production key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ludionGate } from "@ludion/gate-node";
import { generateSiteKey } from "@ludion/gate-core";
import { generateRegistryKey } from "@ludion/gate-core/staple";
import { createDiverSigner, createRegistryClient, createStapleKeeper, directoryDocument } from "@ludion/diver";
import { createRegistry, createMemoryStore } from "../src/index.mjs";
import { nodeListener } from "../src/node.mjs";
import { diverStore } from "./support.mjs";

const BIN = fileURLToPath(new URL("../bin/registry.mjs", import.meta.url));
export const ISSUER = "https://registry.ludion.ai";

export const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ludion-${tag}-`));

/** The Registry as its own process (it can be killed). */
export async function registryProcess({ dir, args = [] }) {
  const keyFile = path.join(dir, "registry-key.json");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JSON.stringify((await generateRegistryKey()).privateJwk), { mode: 0o600 });
  const child = spawn(process.execPath, [BIN, "--key", keyFile, "--state", path.join(dir, "state.json"), "--port", "0", "--scheme", "http", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const line = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve(buf.slice(0, i)); });
    child.once("exit", (code) => reject(new Error(`registry exited ${code}: ${stderr}`)));
  });
  const { listening } = JSON.parse(line);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { url: listening, child, exited, kill: async () => { child.kill("SIGKILL"); await exited; } };
}

/** The Registry in this process, with a clock the test drives. */
export async function registryServer({ now, sseRetryMs = 200, contactsVerified = true } = {}) {
  const key = await generateRegistryKey();
  const registry = await createRegistry({ key: key.privateJwk, store: createMemoryStore(), now, sseRetryMs, contactsVerified, heartbeatMs: 5000 });
  const server = http.createServer(nodeListener(registry, { scheme: "http" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { registry, server, url: `http://127.0.0.1:${server.address().port}`, close: () => { registry.close(); server.closeAllConnections?.(); server.close(); } };
}

/**
 * A TCP proxy in front of a server that records every byte clients send, and can go dark
 * (drop every connection and refuse new ones) to cut the revocation stream.
 */
export async function recordingProxy(targetPort) {
  const bytes = [];
  const sockets = new Set();
  let dark = false;
  const server = net.createServer((c) => {
    if (dark) { c.destroy(); return; }
    const up = net.connect(targetPort, "127.0.0.1");
    sockets.add(c); sockets.add(up);
    const conn = { chunks: [] };
    bytes.push(conn);
    c.on("data", (d) => { conn.chunks.push(Buffer.from(d)); });
    c.pipe(up); up.pipe(c);
    const end = () => { c.destroy(); up.destroy(); sockets.delete(c); sockets.delete(up); };
    c.on("error", end); up.on("error", end); c.on("close", end); up.on("close", end);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Every byte received, per connection, as latin1 text. */
    received: () => bytes.map((c) => Buffer.concat(c.chunks).toString("latin1")),
    goDark() { dark = true; for (const s of sockets) s.destroy(); sockets.clear(); },
    goLight() { dark = false; },
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

/** A fetch for key discovery that serves each agent's published directory from memory. */
export function directoryHost() {
  const docs = new Map();
  return {
    publish(store) {
      const keys = [store.session, ...(store.next ? [store.next] : [])].map((k) => ({ kty: "OKP", crv: "Ed25519", x: k.x, kid: k.kid }));
      docs.set(`${new URL(store.signature_agent).origin}/.well-known/http-message-signatures-directory`, directoryDocument(keys));
    },
    fetch: async (url) => {
      const d = docs.get(String(url));
      return d ? new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/http-message-signatures-directory+json", "cache-control": "max-age=60" } })
        : new Response("", { status: 404 });
    },
  };
}

/**
 * A site running the real Node Gate. Allowed requests answer with what the Gate decided, so a test
 * reads the class and standing from the body; denied ones carry Ludion-Error.
 * A request with `?total=<amount>&currency=<ISO>` is a checkout: the site charges that amount
 * through req.ludion.charge (the Gate never reads the cart; the site knows the total) and answers
 * the Gate's refusal if there is one. The answer then carries `charge`.
 */
export async function site({ host = "shop.example", authorities = [host], clock, registryKeys, revocations, directory, routes, categories }) {
  const siteKey = await generateSiteKey();
  const mw = await ludionGate({
    siteId: `site-${host}`, siteKey: siteKey.privateJwk, pressure: 0, now: () => clock.now(), authorities,
    routes: routes ?? [{ match: "/checkout/**", pressure: 2, require: { depth: 1, ballast: "active" } }, { match: "/account", pressure: 2 }],
    registryKeys, registryIssuer: ISSUER, resolver: { fetch: directory.fetch },
    ...(revocations ? { revocations } : {}), ...(categories ? { categories } : {}),
  });
  let last; // the last request the site saw (tests send one at a time): its Gate result, even when denied
  const server = http.createServer((req, res) => { last = req; return mw(req, res, () => {
    const c = req.ludion.cls;
    const q = new URL(req.url, "http://site.invalid").searchParams;
    let charge;
    if (q.has("total")) {
      charge = req.ludion.charge({ amount: Number(q.get("total")), currency: q.get("currency") });
      if (!charge.ok) {
        res.writeHead(charge.status, { ...charge.headers, "content-type": "application/json" });
        return res.end(JSON.stringify({ error: charge.error, reason: charge.reason }));
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ class: c.class, depth: c.depth ?? null, ballast: c.ballast?.status ?? null, revoked: c.revocation?.reason ?? null,
      reason: c.reason ?? c.stapleError ?? null, detail: c.detail ?? null, mandate: c.mandate?.jti ?? null, mandateError: c.mandateError ?? null,
      ...(charge ? { charge } : {}) }));
  }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    gate: mw.gate, host, origin,
    /** Send a request as it would arrive at https://<as><path> (`as`: another of the Gate's authorities). */
    send(pathname, headers = {}, method = "GET", as = host) {
      const t = performance.now();
      return new Promise((resolve, reject) => {
        const req = http.request(`${origin}${pathname}`, { method, headers: { ...headers, host: as }, agent: false }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            try { parsed = JSON.parse(body); } catch { /* not JSON */ }
            resolve({ status: res.statusCode, error: res.headers["ludion-error"] ?? null, link: res.headers.link ?? null,
              body: res.statusCode === 200 ? parsed : null, refusal: res.statusCode === 200 ? null : parsed, cls: last?.ludion?.cls ?? null, ms: performance.now() - t });
          });
        });
        req.on("error", reject);
        req.end();
      });
    },
    close: () => { mw.gate.close?.(); server.closeAllConnections?.(); server.close(); },
  };
}

/** A registered Diver: its store, its Root (open, test only), a Registry client and a signer. */
export async function agent({ registryUrl, clock, directory, name, fetch }) {
  const d = await diverStore(name);
  const client = createRegistryClient({ url: registryUrl, now: () => clock.now(), ...(fetch ? { fetch } : {}) });
  await client.register(d.store, d.root);
  await client.approveKeys(d.store, d.root, [d.session]);
  directory.publish(d.store);
  let staple;
  const a = {
    ...d, client,
    async refresh() { staple = await client.staple(d.store, d.session); return staple; },
    get staple() { return staple; },
    set staple(s) { staple = s; },
    /** Signed headers for a request to https://<host><path>, carrying the current Staple (or none) and a Mandate if given. */
    async headers(host, pathname, { method = "GET", withStaple = true, mandate } = {}) {
      const signer = await createDiverSigner({ sessionPrivateJwk: d.session, signatureAgent: d.store.signature_agent, now: () => clock.now(),
        staple: () => (withStaple ? staple?.staple : undefined), mandate: () => mandate });
      return signer.headersFor({ method, url: `https://${host}${pathname}` });
    },
    keeper: (o = {}) => createStapleKeeper({ client, store: d.store, sessionPrivateJwk: d.session, now: () => clock.now(), ...o }),
  };
  await a.refresh();
  return a;
}

/** A clock the test moves: real time plus an offset. */
export function testClock() {
  let offset = 0;
  return { now: () => Date.now() + offset, advanceTo: (t) => { offset = t - Date.now(); }, reset: () => { offset = 0; } };
}

export const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
