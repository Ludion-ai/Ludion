// PRIV-1 (docs/MISSION.md §4, spec §8.6 / §11.7): what leaves the Gate is metadata only.
// ./egress/workload.mjs runs 10,000 requests of every class through the real Node adapter in a
// child process under ./egress/trap.mjs, which records every byte the process could send out:
// sink payloads, every fetch in full, any socket/DNS/HTTP client/subprocess attempt, file writes,
// stdout and stderr. Canaries are planted in bodies, cookies, query values, a path segment, the
// Host and every non-signature header value; raw client IPs in the socket address,
// X-Forwarded-For, X-Real-IP, Forwarded, True-Client-IP and CF-Connecting-IP.
// The egress must hold 0 canaries (raw, any case, base64, base64url, hex) and 0 raw IPs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TRAP = pathToFileURL(path.join(DIR, "egress/trap.mjs")).href;
const WORKLOAD = path.join(DIR, "egress/workload.mjs");

/** Run the workload under the trap; returns { records, meta, stdout, stderr }. */
export function runWorkload(env) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ludion-priv-")), "egress.json");
  const r = spawnSync(process.execPath, ["--import", TRAP, WORKLOAD], {
    env: { ...process.env, LUDION_EGRESS_LOG: log, ...env }, encoding: "latin1", maxBuffer: 256e6, timeout: 240_000,
  });
  assert.equal(r.status, 0, `workload exited ${r.status}: ${(r.stderr ?? "").slice(-800)}`);
  const { records, meta } = JSON.parse(fs.readFileSync(log, "utf8"));
  fs.rmSync(path.dirname(log), { recursive: true, force: true });
  return { records, meta, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Every encoding of the canary prefix a leak could plausibly take. */
function canaryForms(prefix) {
  const forms = new Set([prefix.toLowerCase()]);
  for (const p of [prefix.toLowerCase(), prefix.toUpperCase()]) {
    forms.add(Buffer.from(p).toString("hex")); forms.add(Buffer.from(p).toString("hex").toUpperCase());
    for (let pad = 0; pad < 3; pad++) { // the base64 of the prefix at each of the three alignments
      const b = Buffer.from("x".repeat(pad) + p);
      for (const enc of ["base64", "base64url"]) {
        const s = b.toString(enc), skip = Math.ceil((pad * 4) / 3) + 1;
        forms.add(s.slice(skip, s.length - 2));
      }
    }
  }
  return [...forms].filter((f) => f.length >= 8);
}

/** Raw IPs from `planted` that appear anywhere in `text` (IPv4 by regex, IPv6 by token). */
function rawIps(text, planted) {
  const set = new Set(planted.map((a) => a.toLowerCase())), found = new Set();
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) if (set.has(m[1])) found.add(m[1]);
  for (const tok of text.toLowerCase().split(/[^0-9a-f:.]+/)) {
    if (!tok.includes(":")) continue;
    // Every run of whole ':'-groups (catches an address with a port or glued to other hex).
    const g = tok.split(":");
    for (let i = 0; i < g.length; i++) for (let j = i + 2; j <= g.length; j++) {
      const t = g.slice(i, j).join(":").replace(/^[.]+|[.]+$/g, "");
      if (set.has(t)) found.add(t);
    }
  }
  return [...found];
}

/** What left the process, as one string per channel entry (meta excluded: it is the test's own). */
function egressText({ records, stdout, stderr }) {
  return [...records.map((r) => JSON.stringify(r)), stdout, stderr];
}

export function leaks(run) {
  const chunks = egressText(run);
  const forms = canaryForms(run.meta.prefix);
  const canaries = [];
  for (const c of chunks) {
    const low = c.toLowerCase();
    for (const f of forms) {
      const at = (f === f.toLowerCase() ? low : c).indexOf(f);
      if (at >= 0) canaries.push(`${f} in ${c.slice(Math.max(0, at - 60), at + 40)}`);
    }
  }
  const ips = rawIps(chunks.join("\n"), run.meta.planted);
  return { canaries, ips };
}

const EVERY_CLASS = ["VERIFIED", "UNVERIFIED", "SPOOFED", "REVOKED", "DECLARED", "SUSPECTED", "UNKNOWN"];
function classesSeen(tally) {
  const seen = {};
  for (const [k, n] of Object.entries(tally)) { const cls = k.split(">")[1]; seen[cls] = (seen[cls] ?? 0) + n; }
  return seen;
}

for (const trustProxy of [false, true]) {
  test(`PRIV-1: 10,000 canaried requests of every class, send_metadata true, trustProxy ${trustProxy}: 0 canaries and 0 raw IPs leave the Gate`, { timeout: 300_000 }, () => {
    const run = runWorkload({ PRIV_N: "10000", PRIV_TRUST_PROXY: trustProxy ? "1" : "0", PRIV_SEND_METADATA: "1" });
    const seen = classesSeen(run.meta.tally);
    for (const cls of EVERY_CLASS) assert.ok(seen[cls] >= 100, `class ${cls} exercised only ${seen[cls] ?? 0} times: ${JSON.stringify(run.meta.tally)}`);
    const sinks = run.records.filter((r) => r.ch === "sink").length, fetches = run.records.filter((r) => r.ch === "fetch").length;
    assert.ok(sinks >= 5000, `only ${sinks} metadata events reached the sink: the egress path is not exercised`);
    assert.ok(fetches >= 1, "no key directory was fetched: the fetch egress path is not exercised");
    assert.ok(run.meta.planted.length >= 10_000, "too few raw IPs planted");
    const { canaries, ips } = leaks(run);
    assert.deepEqual(canaries.slice(0, 10), [], `${canaries.length} canary sightings`);
    assert.deepEqual(ips.slice(0, 10), [], `${ips.length} raw IPs`);
  });
}

// The two leaks the workload found in the seed Gate, pinned in the fast loop.
test("PRIV-1: a metadata event carries a country code or nothing, a route of route words only, and a known method", async () => {
  const { metadataEvent, countryCode } = await import("@ludion/gate-core");
  const receipt = { rid: "rcp-x", site: "s", ts: 1, method: "GET", route: "/users/zelda", class: "DECLARED", decision: "allow", error: null, pressure: 0, diver: null };
  for (const [given, want] of [["JP", "JP"], ["us", "US"], ["XX", "XX"], ["T1", "T1"], [" DE ", "DE"], ["ludioncanaryq", null], ["J P", null], ["JPN", null], ["", null], [undefined, null], [7, null]]) {
    assert.equal(countryCode(given), want, `country ${JSON.stringify(given)}`);
  }
  const e = metadataEvent({ receipt, path: "/users/zelda/orders/123", ip: "203.0.113.9", ipSalt: "s", country: "ludioncanaryq" });
  assert.equal(e.route, "/users/:param/orders/:id");
  assert.equal(e.country, null);
  assert.ok(!JSON.stringify(e).includes("203.0.113.9") && !JSON.stringify(e).includes("zelda"));
  assert.equal(metadataEvent({ receipt: { ...receipt, method: "LUDIONCANARY" }, path: "/" }).method, "OTHER");
});

test("PRIV-1: the checker bites — a planted canary or raw IP in any channel is found", () => {
  const meta = { prefix: "ludioncanary", planted: ["203.0.113.9", "2001:db8:1:2::3"] };
  const clean = { records: [{ ch: "sink", data: { route: "/p/:param", ip_h: "abc" } }], meta, stdout: "", stderr: "" };
  assert.deepEqual(leaks(clean), { canaries: [], ips: [] });
  const dirty = [
    { records: [{ ch: "sink", data: { route: "/p/ludioncanaryabcp" } }] },
    { records: [{ ch: "fetch", url: "https://x.example/", headers: [["x", "LUDIONCANARYQ"]] }] },
    { records: [{ ch: "sink", data: { blob: Buffer.from('{"c":"ludioncanaryxyz"}').toString("base64") } }] },
    { records: [{ ch: "sink", data: { blob: Buffer.from("..ludioncanaryxyz").toString("base64url") } }] },
    { records: [{ ch: "sink", data: { blob: Buffer.from("ludioncanaryxyz").toString("hex") } }] },
    { records: [], stdout: "debug: ludioncanaryxy" },
    { records: [], stderr: "LudionCanaryXY" },
    { records: [{ ch: "net.connect", args: ["ludioncanaryxy.example"] }] },
    { records: [{ ch: "sink", data: { ip: "203.0.113.9" } }] },
    { records: [{ ch: "sink", data: { xff: "for=[2001:db8:1:2::3]" } }] },
    { records: [], stderr: "client 2001:db8:1:2::3 said hi" },
  ];
  for (const d of dirty) {
    const l = leaks({ records: d.records, meta, stdout: d.stdout ?? "", stderr: d.stderr ?? "" });
    assert.ok(l.canaries.length + l.ips.length > 0, `missed a leak in ${JSON.stringify(d)}`);
  }
});
