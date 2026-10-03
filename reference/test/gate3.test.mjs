// GATE-3 (+, pair GATE-13, property install-effort; docs/MISSION.md §4): the Gate goes in within 60 seconds. For each reference app
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
import { ROOT, prepare, start, freePort, stopAll, raw, node, BUILD_MTIME } from "../harness.mjs";
import { LIMIT_S, MAX_CODE_LINES, MAX_CONFIG_FILES, README, walk, installDiff, installProblems, eventProblems } from "../gate3-measure.mjs";

after(stopAll); // a timed-out test skips its finally; no server may outlive the file
import { automationRequest } from "../requests.mjs";

// The measures — the install's diff and what the first event must be — are in ../gate3-measure.mjs,
// where GATE-13 plants installs and events to show they catch what they must.

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
    const readme = fs.readFileSync(path.join(ROOT, "packages", README[app], "README.md"), "utf8");
    assert.deepEqual(installProblems(app, d, readme), []);

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
      assert.deepEqual(eventProblems(app, first, { t0, site: cfg.site_id }), [], first ? undefined : server.log.slice(-1500));
      const seconds = (first.at - t0) / 1000;
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
