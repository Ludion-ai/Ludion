// GATE-1 (docs/MISSION.md §4): humans are untouched. Three reference apps (Express, Next.js,
// Cloudflare Workers) run for real, once without the Gate and once installed the way a customer
// installs it (reference/<app>/install). Unsigned browser traffic (reference/requests.mjs) at
// Pressure 0, 1, 2 and 3 must get byte-identical responses except the Gate's `Ludion-*` headers:
// status line, every other header in order, and the body bytes on the wire.
//
// Two servers without the Gate are compared first (the control). Anything that differs there is
// nondeterminism in the app or the platform, and the only parts masked are listed in
// NORMALISATIONS below. A control mismatch fails the suite: an unexplained difference is never
// masked after the fact.
//
// The suite also proves the Gate was really there: every gated response carries a receipt that
// says UNKNOWN at the route's pressure, streamed bodies still stream, and the same Gate denies an
// unsigned bot on a Pressure-2 route.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepare, start, freePort, raw, comparable, receiptOf, header, decoded, renaming } from "../harness.mjs";
import { browserRequests, automationRequest } from "../requests.mjs";

const PRESSURES = [0, 1, 2, 3];

/** Everything GATE-1 masks, per app, with the reason. Keep this list short and explained. */
export const NORMALISATIONS = {
  date: { name: "date", header: "date", why: "the Date header is the server clock" },
  chunks: { name: "chunk-framing", why: "compressed responses are flushed on timing (workerd's and Next's gzip streams), so Transfer-Encoding chunk boundaries differ between two runs of the same server; the de-chunked bytes are still compared exactly" },
  assets: { name: "build-asset-names", why: "Next.js compiles proxy.js into the same build, and the bundler numbers modules across the whole build: the Gate's server-only modules shift one client module ID, which renames the content-hashed chunks that contain it. Accepted only as a consistent renaming of /_next/static asset names in the page (and, inside those chunks, of module IDs), with ETag and Content-Length (hashes/lengths of the renamed body) masked for exactly those responses; every referenced chunk is fetched from both servers and must be identical under the same renaming" },
};
const APPS = {
  express: { masks: ["date"] },
  next: { masks: ["date", "chunks", "assets"], ungated: { "firefox: permanent redirect": "next.config.js redirects() run before proxy.js (Next.js routing order), so the Gate never sees them" } },
  workers: { masks: ["date", "chunks"] },
};

/** The site config each gated server runs with: the spec's shape, critical routes at ≥ 2. */
const siteConfig = (app, p) => ({ site_id: `site-reference-${app}`, pressure: p, routes: [
  { match: "/checkout/**", pressure: Math.max(p, 2), require: { depth: 1 } },
  { match: "/login", pressure: Math.max(p, 2), require: { depth: 1 } },
  { match: "/account", pressure: Math.max(p, 2), require: { depth: 1 } },
] });
const routePressure = (p, reqPath) => (/^\/(checkout\/|login$|account$)/.test(reqPath.split("?")[0]) ? Math.max(p, 2) : p);

async function gatedEnv(app, p, dir) {
  const cfg = siteConfig(app, p);
  if (app === "workers") return { LUDION: JSON.stringify(cfg) };
  const file = path.join(dir, `ludion.p${p}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { LUDION_CONFIG: file };
}

function dechunkedView(r) { return { ...r, wire: r.body }; } // same head, wire = de-chunked payload

/**
 * Compare one response with another. Returns null when equal, else a reason.
 * `renamed` (Next.js only) collects, per path, the ETags of GET pages accepted as renamings, so a
 * HEAD of the same page may differ in exactly that ETag and nothing else.
 */
async function differs(app, x, y, assetMaps, { reqPath, isHead, renamed } = {}) {
  const masks = APPS[app].masks.map((m) => NORMALISATIONS[m]);
  const view = (r) => (APPS[app].masks.includes("chunks") ? dechunkedView(r) : r);
  const cx = comparable(view(x), masks), cy = comparable(view(y), masks);
  if (cx === cy) return null;
  if (!APPS[app].masks.includes("assets") || !assetMaps) return firstDifference(cx, cy);
  // Build-asset renaming: headers equal except the body-derived ETag / Content-Length, bodies a
  // consistent renaming of asset names.
  const bodyDerived = [...masks, { name: "etag", header: "etag" }, { name: "length", header: "content-length" }];
  const hx = comparable({ ...x, wire: Buffer.alloc(0) }, bodyDerived), hy = comparable({ ...y, wire: Buffer.alloc(0) }, bodyDerived);
  if (hx !== hy) return firstDifference(hx, hy);
  if (isHead) {
    const get = renamed?.get(reqPath);
    return get && get.a === header(x, "etag") && get.b === header(y, "etag") ? null : `HEAD differs in ETag/Content-Length without a renamed GET of ${reqPath} to explain it`;
  }
  const r = renaming((await decoded(x)).toString("latin1"), (await decoded(y)).toString("latin1"), assetMaps);
  if (!(r.ok && r.renamed > 0)) return `body: ${r.reason ?? "differs without a rename"}`;
  renamed?.set(reqPath, { a: header(x, "etag"), b: header(y, "etag") });
  return null;
}
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `first difference at byte ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 80), i + 80))} vs ${JSON.stringify(b.slice(Math.max(0, i - 80), i + 80))}`;
}

for (const app of Object.keys(APPS)) {
  test(`GATE-1: ${app}: unsigned browser traffic is byte-identical with and without the Gate at Pressure 0–3`, { timeout: 1_200_000 }, async () => {
    const { A, B } = prepare(app);
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), `ludion-gate1-${app}-`));
    const servers = [];
    try {
      const up = async (dir, env) => { const s = await start(app, dir, await freePort(), { env }); servers.push(s); return s; };
      const [base, control, ...gated] = await Promise.all([up(A, {}), up(A, {}),
        ...PRESSURES.map(async (p) => up(B, await gatedEnv(app, p, cfgDir)))]);
      const problems = [];
      const assetMaps = PRESSURES.map(() => ({ fwd: new Map(), back: new Map() }));
      const pages = PRESSURES.map(() => []);
      const renamedPages = PRESSURES.map(() => new Map());
      let compared = 0;

      for (const req of browserRequests()) {
        const x = await raw(base.port, req.bytes);
        const c = await raw(control.port, req.bytes);
        const ctl = await differs(app, x, c, null);
        if (ctl) { problems.push(`control (no Gate vs no Gate) ${req.name}: ${ctl}`); continue; }
        const reqPath = req.bytes.toString("latin1").split(" ")[1];
        for (const [i, p] of PRESSURES.entries()) {
          const y = await raw(gated[i].port, req.bytes);
          const d = await differs(app, x, y, assetMaps[i], { reqPath, isHead: /^HEAD /.test(req.bytes.toString("latin1", 0, 5)), renamed: renamedPages[i] });
          if (d) problems.push(`P${p} ${req.name}: ${d}`);
          compared++;
          const rc = receiptOf(y), exempt = APPS[app].ungated?.[req.name];
          if (exempt) { if (rc) problems.push(`P${p} ${req.name}: expected no receipt (${exempt})`); }
          else if (!rc) problems.push(`P${p} ${req.name}: no Ludion-Receipt, so the Gate did not run`);
          else if (rc.class !== "UNKNOWN" || rc.decision !== "allow" || rc.pressure !== routePressure(p, reqPath)) {
            problems.push(`P${p} ${req.name}: receipt says ${rc.class}/${rc.decision} at P${rc.pressure}, expected UNKNOWN/allow at P${routePressure(p, reqPath)}`);
          }
          if (req.stream) {
            const first = (r) => r.firstBodyAt - r.sentAt, spread = (r) => r.endAt - r.firstBodyAt;
            if (first(y) > first(x) + 150) problems.push(`P${p} ${req.name}: first body byte ${first(y).toFixed(0)}ms vs ${first(x).toFixed(0)}ms without the Gate`);
            if (spread(y) < 300 || spread(y) < spread(x) - 150) problems.push(`P${p} ${req.name}: body arrived over ${spread(y).toFixed(0)}ms vs ${spread(x).toFixed(0)}ms (buffered, not streamed)`);
          }
          if (APPS[app].masks.includes("assets") && /text\/html/.test(header(x, "content-type") ?? "") && x.body.length) pages[i].push([x, y]);
        }
      }

      // Next.js: every build asset a page references is fetched from both servers and must be the
      // same file, or the same file under the renaming the pages already committed to.
      if (APPS[app].masks.includes("assets")) {
        for (const [i, p] of PRESSURES.entries()) {
          const seen = new Set();
          for (const [x, y] of pages[i]) {
            const ua = (await decoded(x)).toString("latin1").match(/\/_next\/static\/[A-Za-z0-9_./-]+\.(?:js|css)/g) ?? [];
            const ub = (await decoded(y)).toString("latin1").match(/\/_next\/static\/[A-Za-z0-9_./-]+\.(?:js|css)/g) ?? [];
            if (ua.length !== ub.length) { problems.push(`P${p}: pages reference ${ua.length} vs ${ub.length} assets`); continue; }
            for (const [k, u] of ua.entries()) {
              if (seen.has(u)) continue;
              seen.add(u);
              const get = (url) => Buffer.from(`GET ${url} HTTP/1.1\r\nHost: shop.example\r\nConnection: keep-alive\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36\r\nAccept: */*\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: no-cors\r\nSec-Fetch-Dest: script\r\nReferer: http://shop.example/\r\nAccept-Encoding: gzip, deflate, br, zstd\r\nAccept-Language: ja,en-US;q=0.9,en;q=0.8\r\n\r\n`, "latin1");
              const ax = await raw(base.port, get(u)), by = await raw(gated[i].port, get(ub[k]));
              if (ax.status !== 200 || by.status !== 200) { problems.push(`P${p} asset ${u}: ${ax.status} / ${by.status}`); continue; }
              if (u === ub[k]) { const d = await differs(app, ax, by, null); if (d) problems.push(`P${p} asset ${u} (same name, different bytes): ${d}`); continue; }
              const masks = APPS[app].masks.map((m) => NORMALISATIONS[m]);
              const hm = [...masks, { name: "etag", header: "etag" }, { name: "length", header: "content-length" }];
              if (comparable({ ...ax, wire: Buffer.alloc(0) }, hm) !== comparable({ ...by, wire: Buffer.alloc(0) }, hm)) problems.push(`P${p} asset ${u} → ${ub[k]}: headers differ`);
              const r = renaming((await decoded(ax)).toString("latin1"), (await decoded(by)).toString("latin1"), { numeric: true, mangled: true, ...assetMaps[i] });
              if (!r.ok) problems.push(`P${p} asset ${u} → ${ub[k]}: not the same code under the renaming: ${r.reason}`);
            }
          }
        }
      }

      // The Gate is live and enforcing in exactly these servers: an unsigned bot is denied on a
      // Pressure-2 route, and on the site root only once the site itself is at Pressure ≥ 2.
      for (const [i, p] of PRESSURES.entries()) {
        const bot = await raw(gated[i].port, automationRequest("shop.example", { path: "/checkout/1" }));
        if (bot.status !== 401 || header(bot, "ludion-error") !== "signature_required") problems.push(`P${p}: an unsigned bot on /checkout/1 got ${bot.status} ${header(bot, "ludion-error") ?? ""}, expected 401 signature_required`);
        const home = await raw(gated[i].port, automationRequest("shop.example", { path: "/" }));
        const want = p >= 2 ? 401 : 200;
        if (home.status !== want) problems.push(`P${p}: an unsigned bot on / got ${home.status}, expected ${want}`);
      }

      assert.ok(compared >= browserRequests().length * PRESSURES.length - 1, `compared only ${compared} responses`);
      assert.deepEqual(problems, [], `${app}: ${problems.length} problem(s)`);
    } finally {
      await Promise.all(servers.map((s) => s.stop()));
      fs.rmSync(cfgDir, { recursive: true, force: true });
    }
  });
}
