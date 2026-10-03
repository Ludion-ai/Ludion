// GATE-3 (docs/MISSION.md §4): the Gate goes in within 60 seconds. For each reference app
// (Express, Next.js, Cloudflare Workers):
//   - the install (reference/<app>/install, overlaid on reference/<app>/site) changes at most 3
//     lines of application code, measured with `git diff --no-index`, and at most 1 config file;
//     nothing else is touched (the dependency itself arrives with `npm install`);
//   - the lines the founder shows (the adapter's README) are exactly the lines this test installs;
//   - from process start (for Next.js: from `next build`) to the first classified event arriving
//     at the site's report endpoint takes at most 60 s. Dependency download is excluded: the
//     install happens in prepare(), before the clock starts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REF, ROOT, prepare, start, freePort, stopAll, raw, node, BUILD_MTIME } from "../harness.mjs";

after(stopAll); // a timed-out test skips its finally; no server may outlive the file
import { automationRequest } from "../requests.mjs";

const LIMIT_S = 60, MAX_CODE_LINES = 3, MAX_CONFIG_FILES = 1;
const CONFIG_FILES = new Set(["ludion.config.json", "wrangler.toml", "wrangler.json", "wrangler.jsonc"]);
const README = { express: "gate-node", next: "gate-next", workers: "gate-workers" };

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/** Lines changed by the install, per file, from a real diff: each hunk counts max(removed, added). */
export function installDiff(app) {
  const site = path.join(REF, app, "site"), install = path.join(REF, app, "install");
  const files = walk(install).map((f) => {
    const before = path.join(site, f), after = path.join(install, f);
    let out;
    try { out = execFileSync("git", ["diff", "--no-index", "--no-color", "-U0", fs.existsSync(before) ? before : "/dev/null", after], { encoding: "utf8" }); }
    catch (e) { if (e.status !== 1) throw e; out = e.stdout; } // exit 1 = the files differ
    let changed = 0;
    const added = [];
    for (const m of out.matchAll(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) changed += Math.max(Number(m[1] ?? 1), Number(m[2] ?? 1));
    for (const l of out.split("\n")) if (l.startsWith("+") && !l.startsWith("+++")) added.push(l.slice(1));
    return { file: f, config: CONFIG_FILES.has(path.basename(f)), changed, added, created: !fs.existsSync(before) };
  });
  return { files, codeLines: files.filter((f) => !f.config).reduce((s, f) => s + f.changed, 0), configFiles: files.filter((f) => f.config).length };
}

async function collector() {
  const events = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { try { events.push({ at: performance.now(), event: JSON.parse(body) }); } catch { events.push({ at: performance.now(), bad: body }); } res.writeHead(204).end(); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { events, url: `http://127.0.0.1:${srv.address().port}/events`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

const results = {};

for (const app of ["express", "next", "workers"]) {
  test(`GATE-3: ${app}: ≤${MAX_CODE_LINES} app lines, ≤${MAX_CONFIG_FILES} config file, first classified event ≤${LIMIT_S}s`, { timeout: 900_000 }, async () => {
    // ── the install, measured ─────────────────────────────────────────────────────────────
    const d = installDiff(app);
    assert.ok(d.files.length > 0, "an install that changes nothing proves nothing");
    assert.ok(d.codeLines <= MAX_CODE_LINES, `${app}: ${d.codeLines} application lines changed (${d.files.map((f) => `${f.file}:${f.changed}`).join(", ")})`);
    assert.ok(d.configFiles <= MAX_CONFIG_FILES, `${app}: ${d.configFiles} config files`);
    assert.ok(!d.files.some((f) => /(^|\/)package(-lock)?\.json$/.test(f.file)), "dependencies come from npm install, not a hand edit");
    const readme = fs.readFileSync(path.join(ROOT, "packages", README[app], "README.md"), "utf8");
    for (const f of d.files.filter((x) => !x.config)) for (const line of f.added.filter((l) => l.trim())) {
      assert.ok(readme.includes(line.trim()), `${app}: the README of @ludion/${README[app]} does not show the installed line ${JSON.stringify(line.trim())}`);
    }

    // ── the clock: process start → first classified event ───────────────────────────────────
    const { B } = prepare(app); // installs happen here, outside the clock
    const sink = await collector();
    const cfg = { site_id: `site-reference-${app}`, pressure: 0, report: { endpoint: sink.url } };
    const cfgFile = path.join(B, "..", `gate3-${process.pid}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const env = app === "workers" ? { LUDION: JSON.stringify(cfg) } : { LUDION_CONFIG: cfgFile };
    let server;
    try {
      const port = await freePort();
      const t0 = performance.now();
      let builtAt = t0;
      if (app === "next") {
        fs.rmSync(path.join(B, ".next"), { recursive: true, force: true });
        node(B, ["node_modules/next/dist/bin/next", "build"], { NEXT_TELEMETRY_DISABLED: "1" });
        builtAt = performance.now();
      }
      server = await start(app, B, port, { env, ready: false });
      const deadline = t0 + LIMIT_S * 1000;
      while (!sink.events.length && performance.now() < deadline) {
        if (server.child.exitCode != null) throw new Error(`server exited: ${server.log.slice(-1500)}`);
        try { await raw(port, automationRequest("shop.example", { path: "/products/2", ua: "curl/8.7.1" }), { timeoutMs: 5_000 }); } catch { /* not listening yet */ }
        if (!sink.events.length) await new Promise((r) => setTimeout(r, 200));
      }
      const first = sink.events[0];
      assert.ok(first, `${app}: no classified event within ${LIMIT_S}s\n${server.log.slice(-1500)}`);
      const seconds = (first.at - t0) / 1000;
      assert.ok(first.event, `${app}: the sink got something that is not JSON: ${first.bad}`);
      assert.equal(first.event.site, cfg.site_id);
      assert.equal(first.event.class, "SUSPECTED");
      assert.equal(first.event.route, "/products/:id");
      assert.ok(seconds <= LIMIT_S, `${app}: first classified event after ${seconds.toFixed(1)}s`);
      results[app] = app === "next" ? `${seconds.toFixed(1)}s (build ${((builtAt - t0) / 1000).toFixed(1)}s)` : `${seconds.toFixed(1)}s`;
      console.log(`${app}: ${d.codeLines} app lines, ${d.configFiles} config file, first event ${results[app]}`);
    } finally {
      await server?.stop();
      await sink.close();
      fs.rmSync(cfgFile, { force: true });
      if (app === "next") {
        // Leave B as prepare() built it (GATE-1 serves it): a whole build, same pinned mtimes. A build
        // this test stopped half way is made again, outside the clock (the cache is shared).
        if (!fs.existsSync(path.join(B, ".next", "BUILD_ID"))) node(B, ["node_modules/next/dist/bin/next", "build"], { NEXT_TELEMETRY_DISABLED: "1" });
        if (fs.existsSync(path.join(B, ".next"))) for (const f of walk(path.join(B, ".next"))) fs.utimesSync(path.join(B, ".next", f), BUILD_MTIME, BUILD_MTIME);
      }
    }
  });
}
