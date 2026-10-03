// Harness for the reference apps (GATE-1, GATE-3). Each app lives as
//   reference/<app>/site/     the site before it installs the Gate (its own package-lock.json)
//   reference/<app>/install/  exactly what installing the Gate adds or changes (overlay)
// prepare() builds two real installs in the OS temp dir, cached by content hash:
//   A = site/ + `npm ci`                                   (no Gate)
//   B = site/ + install/ + `npm ci` + `npm install <packed @ludion tarballs>`   (the customer's install)
// Reference apps are not root workspaces: Next.js and workerd would slow every `npm ci`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REF = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(REF, "..");
const CACHE = path.join(os.tmpdir(), "ludion-reference");
const STALE_MS = 6 * 3600_000;

/** The npm CLI as a JS file, so no .cmd shim or shell is needed on Windows. */
export function npmCli() {
  const c = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const hit = c.find((p) => p && /npm-cli\.js$/.test(p) && fs.existsSync(p));
  if (!hit) throw new Error("npm-cli.js not found next to node");
  return hit;
}
export function npm(args, cwd, env = {}) {
  return execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false", ...env } });
}

const SKIP = new Set(["node_modules", ".next", ".wrangler", ".mf"]);
function files(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}
/** Copy a tree, keeping mtimes (static-file ETags and Last-Modified depend on them). */
function copyTree(from, to) {
  for (const f of files(from)) {
    const src = path.join(from, f), dst = path.join(to, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
  }
}

/** `npm pack` the given workspace packages (deterministic tarballs). */
export function pack(pkgs, dest) {
  fs.mkdirSync(dest, { recursive: true });
  return pkgs.map((p) => {
    const out = JSON.parse(npm(["pack", "--json", "--pack-destination", dest], path.join(ROOT, "packages", p)));
    return path.join(dest, out[0].filename);
  });
}

export const APPS = {
  // The one package on npm (ADR-036): the Gate comes inside `ludion`, as ludion/gate/<runtime>.
  express: { packages: ["ludion"] },
  next: { packages: ["ludion"], build: (dir) => { node(dir, ["node_modules/next/dist/bin/next", "build"], { NEXT_TELEMETRY_DISABLED: "1" }); pinMtimes(path.join(dir, ".next")); },
    built: (dir) => fs.existsSync(path.join(dir, ".next", "BUILD_ID")) },
  workers: { packages: ["ludion"] },
};
/** Build outputs get one fixed mtime. `next start` derives Last-Modified and ETag of build files
 *  from their mtimes, and A and B are two builds made seconds apart; one real deploy has one build. */
export const BUILD_MTIME = new Date("2026-01-01T00:00:00Z");
function pinMtimes(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) pinMtimes(p); else if (e.isFile()) fs.utimesSync(p, BUILD_MTIME, BUILD_MTIME);
  }
}
export function node(cwd, args, env = {}) {
  return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, env: { ...process.env, ...env } });
}

/**
 * Is a prepared install still whole? GATE-3 rebuilds the shared Next.js install's .next inside its
 * clock; stopped half way, it left no production build behind and GATE-1 failed every run after
 * (2026-10-02). An app with a build step is whole only while both of its builds are there.
 */
export function intact(app, dirs) {
  const built = APPS[app]?.built;
  return !built || (built(dirs.A) && built(dirs.B));
}

/**
 * @param {keyof APPS} app
 * @returns {{ A: string, B: string, key: string }}
 */
export function prepare(app) {
  const spec = APPS[app];
  const tmpPack = fs.mkdtempSync(path.join(os.tmpdir(), `ludion-pack-${app}-`));
  const tarballs = pack(spec.packages, tmpPack);
  const h = createHash("sha256").update(`${process.version}|${process.platform}|${process.arch}\n`);
  for (const part of ["site", "install"]) for (const f of files(path.join(REF, app, part))) h.update(`${part}/${f}\n`).update(fs.readFileSync(path.join(REF, app, part, f)));
  for (const t of tarballs) h.update(fs.readFileSync(t));
  h.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  const key = h.digest("hex").slice(0, 16);
  const base = path.join(CACHE, `${app}-${key}`);
  const out = { A: path.join(base, "A"), B: path.join(base, "B"), key };
  if (fs.existsSync(path.join(base, ".ready"))) {
    fs.rmSync(tmpPack, { recursive: true, force: true });
    // Ready once, but another oracle may have rebuilt part of it and been stopped: build again what is missing.
    if (!intact(app, out)) for (const d of [out.A, out.B]) if (!spec.built(d)) spec.build(d);
    return out;
  }

  // Prune other keys only once they are stale: a key that is not ours may belong to another
  // worktree's scoreboard running right now (or still building, with no .ready yet).
  if (fs.existsSync(CACHE)) for (const d of fs.readdirSync(CACHE)) {
    if (!d.startsWith(`${app}-`) || path.join(CACHE, d) === base) continue;
    const marker = path.join(CACHE, d, ".ready");
    const age = Date.now() - (fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : fs.statSync(path.join(CACHE, d)).mtimeMs);
    if (age > STALE_MS) fs.rmSync(path.join(CACHE, d), { recursive: true, force: true });
  }
  fs.rmSync(base, { recursive: true, force: true }); // our own key without .ready: a half-built leftover
  copyTree(path.join(REF, app, "site"), out.A);
  npm(["ci", "--no-audit", "--no-fund"], out.A);
  copyTree(path.join(REF, app, "site"), out.B);
  copyTree(path.join(REF, app, "install"), out.B);
  npm(["ci", "--no-audit", "--no-fund"], out.B);
  const local = tarballs.map((t) => { const d = path.join(out.B, ".ludion-packages", path.basename(t)); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(t, d); return d; });
  npm(["install", "--no-audit", "--no-fund", ...local], out.B);
  fs.rmSync(tmpPack, { recursive: true, force: true });
  if (spec.build) { spec.build(out.A); spec.build(out.B); }
  fs.writeFileSync(path.join(base, ".ready"), new Date().toISOString());
  return out;
}

// Ports handed out by this process. listen(0)-then-close can return the same port to two callers
// racing in one Promise.all; two servers told the same port was one way GATE-1 hung (#41).
const handedOut = new Set();

/** n distinct free ports: all n sockets are held open at once, then released. */
export async function freePorts(n) {
  const held = [];
  try {
    while (held.length < n) {
      const s = net.createServer();
      await new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
      if (handedOut.has(s.address().port)) { s.close(); continue; }
      held.push(s);
    }
    const ports = held.map((s) => s.address().port);
    for (const p of ports) handedOut.add(p);
    return ports;
  } finally {
    await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
  }
}

export async function freePort() { return (await freePorts(1))[0]; }

const running = new Set();
const STOP_WAIT_MS = 15_000;
/** Children this process started and has not stopped (harness self-test). */
export const liveChildren = () => [...running].filter((c) => c.exitCode == null && c.signalCode == null).length;
process.on("exit", () => { for (const p of running) try { p.kill("SIGKILL"); } catch {} });

/**
 * Stop every server this process started. Test files call it from after(): node:test does not run a
 * timed-out test's finally, and a leftover child (with its pipes) keeps `node --test` alive until
 * the scoreboard kills it, which then reads as "no test matched".
 */
export async function stopAll() {
  await Promise.all([...running].map(async (child) => {
    killTree(child);
    if (child.exitCode == null && child.signalCode == null) await new Promise((r) => { const t = setTimeout(r, STOP_WAIT_MS); child.once("exit", () => { clearTimeout(t); r(); }); });
    child.stdout?.destroy(); child.stderr?.destroy();
    running.delete(child);
  }));
}

/** Kill a child and everything it spawned (next start and wrangler dev fork workers). */
function killTree(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
}

/**
 * Start an app from `dir` on `port`. Resolves once it answers HTTP.
 * @param {keyof APPS} app
 * @param {{ env?: Record<string,string>, ready?: boolean, extraArgs?: string[] }} [opts]
 */
export async function start(app, dir, port, { env = {}, ready = true, readyTimeoutMs } = {}) {
  let args, state;
  if (app === "stub") args = ["-e", env.LUDION_STUB_SCRIPT ?? ""]; // harness self-test only
  else if (app === "express") args = ["server.mjs"];
  else if (app === "next") args = ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"];
  else if (app === "workers") {
    const inspector = await freePort();
    state = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-wrangler-state-")); // parallel instances must not share .wrangler/state (SQLite)
    args = ["node_modules/wrangler/bin/wrangler.js", "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector), "--persist-to", state,
      "--show-interactive-dev-session=false", "--log-level", "warn", ...Object.entries(env).filter(([k]) => k === "LUDION").map(([k, v]) => ["--var", `${k}:${v}`]).flat()];
  } else throw new Error(`unknown app ${app}`);
  const child = spawn(process.execPath, args, {
    cwd: dir, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", ...env },
  });
  running.add(child);
  let log = "";
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const server = { port, child, get log() { return log; }, stop: async () => {
    killTree(child);
    // Bounded: a child that never reports exit must not hang the suite (it did, twice: #32, #41).
    const exited = () => child.exitCode != null || child.signalCode != null;
    if (!exited()) await new Promise((r) => { const t = setTimeout(r, STOP_WAIT_MS); child.once("exit", () => { clearTimeout(t); r(); }); });
    if (!exited()) { try { child.kill("SIGKILL"); } catch {} }
    child.stdout.destroy(); child.stderr.destroy(); // our end of the pipes never keeps the test process alive
    running.delete(child);
    if (state) fs.rmSync(state, { recursive: true, force: true });
  } };
  if (ready) {
    try { await waitReady(server, readyTimeoutMs ? { timeoutMs: readyTimeoutMs } : {}); }
    catch (e) { await server.stop(); throw e; } // never leave a half-started server behind
  }
  return server;
}

export async function waitReady(server, { timeoutMs = 90_000, path: p = "/" } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (server.child.exitCode != null) throw new Error(`server exited (${server.child.exitCode}):\n${server.log.slice(-2000)}`);
    try {
      const r = await raw(server.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36\r\nAccept: text/html\r\nConnection: close\r\n\r\n`, { timeoutMs: 20_000 });
      if (r.status > 0) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on ${server.port} not ready in ${timeoutMs}ms:\n${server.log.slice(-2000)}`);
}

/**
 * One request on a fresh socket, raw bytes in, raw bytes out, with timings.
 * @param {number} port
 * @param {string|Buffer} request
 * @returns {Promise<{ status: number, head: string, headers: [string,string][], wire: Buffer, body: Buffer,
 *   chunks: number[], sentAt: number, headAt: number, firstBodyAt: number|null, endAt: number }>}
 */
export function raw(port, request, { timeoutMs = 30_000 } = {}) {
  const bytes = Buffer.isBuffer(request) ? request : Buffer.from(request, "latin1");
  const isHead = /^HEAD /.test(bytes.toString("latin1", 0, 5));
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), head = null, headEnd = -1, sentAt = 0, headAt = 0, firstBodyAt = null, done = false;
    const arrivals = [];
    const timer = setTimeout(() => finish(new Error(`timeout after ${timeoutMs}ms; got ${buf.length} bytes`)), timeoutMs);
    function finish(err, res) {
      if (done) return; done = true; clearTimeout(timer); sock.destroy();
      err ? reject(err) : resolve(res);
    }
    function tryComplete(closed) {
      if (headEnd < 0) return closed ? finish(new Error(`connection closed before a response head (${buf.length} bytes)`)) : undefined;
      const wire = buf.subarray(headEnd);
      const status = head.status;
      const h = (n) => head.headers.find(([k]) => k.toLowerCase() === n)?.[1];
      let body = null, complete = false;
      if (isHead || status === 204 || status === 304 || (status >= 100 && status < 200)) { body = Buffer.alloc(0); complete = true; }
      else if (/chunked/i.test(h("transfer-encoding") ?? "")) {
        const parts = []; let i = 0;
        for (;;) {
          const eol = wire.indexOf("\r\n", i);
          if (eol < 0) break;
          const size = parseInt(wire.toString("latin1", i, eol).split(";")[0], 16);
          if (Number.isNaN(size)) return finish(new Error("bad chunk size"));
          if (size === 0) {
            // "0\r\n" [trailers] "\r\n": the message ends at the first empty line after the last chunk.
            if (wire.indexOf("\r\n\r\n", eol) >= 0) { body = Buffer.concat(parts); complete = true; }
            break;
          }
          if (wire.length < eol + 2 + size + 2) break;
          parts.push(wire.subarray(eol + 2, eol + 2 + size)); i = eol + 2 + size + 2;
        }
      } else if (h("content-length") != null) {
        const n = Number(h("content-length"));
        if (wire.length >= n) { body = wire.subarray(0, n); complete = true; }
      } else if (closed) { body = wire; complete = true; }
      if (complete) finish(null, { ...head, wire: Buffer.from(wire), body: Buffer.from(body), chunks: arrivals, sentAt, headAt, firstBodyAt, endAt: performance.now() });
      else if (closed) finish(new Error(`connection closed mid-body (${wire.length} bytes)`));
    }
    sock.on("connect", () => { sentAt = performance.now(); sock.write(bytes); });
    sock.on("data", (d) => {
      const t = performance.now();
      buf = Buffer.concat([buf, d]);
      if (headEnd < 0) {
        const i = buf.indexOf("\r\n\r\n");
        if (i >= 0) {
          headEnd = i + 4; headAt = t;
          const text = buf.toString("latin1", 0, i);
          const [statusLine, ...lines] = text.split("\r\n");
          head = { status: Number(statusLine.split(" ")[1]), head: text, statusLine, headers: lines.map((l) => { const c = l.indexOf(":"); return [l.slice(0, c), l.slice(c + 1).trim()]; }) };
          if (buf.length > headEnd) { firstBodyAt = t; arrivals.push(t); }
        }
      } else { firstBodyAt ??= t; arrivals.push(t); }
      tryComplete(false);
    });
    sock.on("end", () => tryComplete(true));
    sock.on("close", () => tryComplete(true));
    sock.on("error", (e) => finish(e));
  });
}

/**
 * What GATE-1 compares: the whole response head and the bytes on the wire (incl. chunk framing),
 * minus the Gate's own `Ludion-*` headers, with the listed nondeterministic parts replaced.
 * @param {{ head: string, wire: Buffer }} r
 * @param {{ name: string, re: RegExp, why: string, header?: string }[]} normalisations
 */
export function comparable(r, normalisations) {
  const [statusLine, ...lines] = r.head.split("\r\n");
  const kept = lines.filter((l) => !/^ludion-/i.test(l)).map((l) => {
    let out = l;
    for (const n of normalisations) if (n.header && l.toLowerCase().startsWith(`${n.header.toLowerCase()}:`)) out = `${l.slice(0, l.indexOf(":"))}: <${n.name}>`;
    return out;
  });
  let wire = r.wire.toString("latin1");
  for (const n of normalisations) if (n.re) wire = wire.replace(n.re, `<${n.name}>`);
  return `${statusLine}\r\n${kept.join("\r\n")}\r\n\r\n${wire}`;
}

/** Receipt the Gate attached, decoded (the Gate ran, at which pressure, what it concluded). */
export function receiptOf(r) {
  const v = r.headers.find(([k]) => k.toLowerCase() === "ludion-receipt")?.[1];
  return v ? JSON.parse(Buffer.from(v, "base64url").toString("utf8")) : null;
}

export const header = (r, name) => r.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** The body as the browser's JS sees it: framing removed, Content-Encoding undone. */
export async function decoded(r) {
  const zlib = await import("node:zlib");
  const enc = (header(r, "content-encoding") ?? "").toLowerCase().trim();
  if (!enc || enc === "identity") return r.body;
  if (enc === "gzip") return zlib.gunzipSync(r.body);
  if (enc === "br") return zlib.brotliDecompressSync(r.body);
  if (enc === "deflate") return zlib.inflateSync(r.body);
  if (enc === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(r.body);
  throw new Error(`cannot decode Content-Encoding ${enc}`);
}

/**
 * Is `b` exactly `a` with some identifiers consistently renamed? Allowed renames: build-asset
 * file names (a token right after "chunks/" or "media/" and before ".js"/".css"/".woff2"…) and,
 * with `numeric`, all-digit tokens (bundler module IDs), and with `mangled`, minified local names
 * (1–2 characters, not a property or key; minifiers mangle per scope, so no bijection) — both only
 * ever allowed inside JS chunks.
 * `fwd`/`back` carry the mapping across calls, so a rename must be the same everywhere.
 * @returns {{ ok: boolean, renamed: number, reason?: string }}
 */
export function renaming(a, b, { numeric = false, mangled = false, fwd = new Map(), back = new Map() } = {}) {
  const re = /[A-Za-z0-9_$-]+|[^A-Za-z0-9_$-]+/g;
  const ta = a.match(re) ?? [], tb = b.match(re) ?? [];
  if (ta.length !== tb.length) return { ok: false, renamed: 0, reason: `token counts differ (${ta.length} vs ${tb.length})` };
  let renamed = 0, locals = 0, before = "";
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i], y = tb[i];
    if (x !== y) {
      const asset = /(^|\/)(chunks|media|css)\/$/.test(before.slice(-8)) && ta[i + 1] === "." && tb[i + 1] === "."
        && /^(js|css|woff2?|map)$/.test(ta[i + 2] ?? "") && ta[i + 2] === tb[i + 2];
      const num = !asset && numeric && /^\d+$/.test(x) && /^\d+$/.test(y);
      // A minifier's local: one or two characters, not a property (after "."), not a key (before ":").
      const local = !asset && !num && mangled && /^[A-Za-z_$][A-Za-z0-9_$]?$/.test(x) && /^[A-Za-z_$][A-Za-z0-9_$]?$/.test(y)
        && !/\.$/.test(before) && !/^:/.test(ta[i + 1] ?? "");
      if (!asset && !num && !local) return { ok: false, renamed, reason: `differs at token ${i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)} after …${JSON.stringify(before.slice(-60))}` };
      if (local) { locals++; renamed++; before = (before + x).slice(-200); continue; } // minifiers mangle per scope: no file-wide bijection
      const kind = asset ? "a" : "n", key = `${kind}:${x}`, val = `${kind}:${y}`;
      if ((fwd.has(key) && fwd.get(key) !== val) || (back.has(val) && back.get(val) !== key)) return { ok: false, renamed, reason: `inconsistent rename of ${x}` };
      fwd.set(key, val); back.set(val, key); renamed++;
    }
    before = (before + x).slice(-200);
  }
  return { ok: true, renamed, locals };
}
