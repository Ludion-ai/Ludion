// accept/registry.mjs — the executable spec. One entry per oracle in docs/MISSION.md §4.
// An entry without `run` is PENDING: that is the backlog. There is no other task list.
//
// Rules (docs/MISSION.md §1): add oracles and make them stricter freely. Never delete, loosen,
// or skip one without a human. `retired` is honoured only once every ID in `retireWhen` passes.
//
// fields: id, m (milestone), kind "+" positive | "-" negative | "±" both inside | "~" hygiene,
//   level 0 = seconds (Stop gate) | 1 = minutes (CI) | 2 = live (needs inputs),
//   pair = the opposite oracle, needs = env vars a human must provide, title,
//   run() → { pass: boolean, metric?: string, detail?: string }
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sh(file, args, timeout = 180_000) {
  try { return { code: 0, out: execFileSync(file, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 64e6 }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message) }; }
}

/** node:test files, optionally filtered by name. Zero matched tests is a FAIL, never a PASS. */
export const nodeTest = (files, pattern, { timeoutMs, metric } = {}) => async () => {
  // Pin the TAP reporter: Node ≥23 prints spec (no "# pass N") even when piped.
  const r = sh(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files], timeoutMs);
  const n = (k) => Number((new RegExp(`^# ${k} (\\d+)`, "m").exec(r.out) ?? [])[1] ?? 0);
  const pass = n("pass"), fail = n("fail");
  if (pass + fail === 0) return { pass: false, detail: "no test matched" };
  return { pass: r.code === 0 && fail === 0, metric: [`${pass} tests`, metric?.(r.out)].filter(Boolean).join("; "), detail: fail ? `${fail} failing` : undefined };
};

/** A node script; exit 0 is PASS. */
export const nodeScript = (file, args = [], { timeoutMs, metric } = {}) => async () => {
  const r = sh(process.execPath, [file, ...args], timeoutMs);
  const oks = (r.out.match(/^ok\s/gm) ?? []).length;
  return { pass: r.code === 0, metric: [oks ? `${oks} checks` : undefined, metric?.(r.out)].filter(Boolean).join("; ") || undefined,
    detail: r.code ? r.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300) : undefined };
};

/** Every part must pass. Metrics and details are joined. */
export const allOf = (...runs) => async () => {
  const rs = [];
  for (const run of runs) rs.push(await run());
  return { pass: rs.every((r) => r.pass), metric: rs.map((r) => r.metric).filter(Boolean).join(" + ") || undefined,
    detail: rs.map((r) => r.detail).filter(Boolean).join(" | ") || undefined };
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(m?[jt]s|cjs|py|go|rs)$/.test(e.name)) out.push(p);
  }
  return out;
}

export const ORACLES = [
  // ── M0 the loop ────────────────────────────────────────────────────────────────
  { id: "LOOP-1", m: "M0", kind: "~", level: 0, title: "MISSION.md catalog and registry hold the same IDs", run: async () => {
    const md = fs.readFileSync(path.join(ROOT, "docs/MISSION.md"), "utf8");
    const doc = new Set([...md.matchAll(/^\|\s*([A-Z]{2,5}-\d+)\s*\|/gm)].map((m) => m[1]));
    const reg = new Set(ORACLES.map((o) => o.id));
    const a = [...doc].filter((x) => !reg.has(x)), b = [...reg].filter((x) => !doc.has(x));
    return { pass: !a.length && !b.length, metric: `${doc.size} ids`,
      detail: [a.length && `unregistered: ${a}`, b.length && `undocumented: ${b}`].filter(Boolean).join("; ") || undefined };
  } },
  { id: "SEED-1", m: "M0", kind: "~", level: 0, title: "seed unit tests green", retireWhen: ["STD-1", "STD-2", "GATE-6", "REG-2", "PRS-1", "DIV-2", "DIV-3"],
    run: nodeTest(["packages/gate-core/test/core.test.mjs", "packages/diver/test/diver.test.mjs"]) },
  { id: "SEED-2", m: "M0", kind: "~", level: 0, title: "seed e2e: my agent → my Gate → VERIFIED", retireWhen: ["GATE-2", "GATE-7", "GATE-8", "PRIV-1", "DIV-1"],
    run: nodeScript("examples/e2e.mjs") },

  // ── M1 standards ───────────────────────────────────────────────────────────────
  { id: "STD-1", m: "M1", kind: "+", level: 0, pair: "STD-2", title: "WG -00 App. E.2 Ed25519 vectors verify through the Gate path",
    run: nodeTest(["packages/gate-core/test/core.test.mjs"], "E\\.2\\.1|thumbprint matches") },
  { id: "STD-2", m: "M1", kind: "-", level: 1, title: "tamper / wrong key / wrong authority / expired / future / >60s / wrong tag all rejected",
    run: nodeTest(["packages/gate-core/test/std2.test.mjs"], "^STD-2:") },
  { id: "STD-3", m: "M1", kind: "+", level: 1, pair: "STD-2", title: "interop both ways with ≥2 independent implementations (one non-JS)" },
  { id: "STD-4", m: "M1", kind: "~", level: 2, title: "pinned draft revisions == latest on datatracker (else issue; FAIL after 7 days)" },

  // ── M1 gate ────────────────────────────────────────────────────────────────────
  // Reference apps (Express, Next.js, Workers) are real installs in the OS temp dir, cached by content hash.
  { id: "GATE-1", m: "M1", kind: "+", level: 1, pair: "GATE-2", title: "humans untouched: responses byte-identical with/without Gate at P0–3 (reference apps)",
    timeoutMs: 1_800_000, run: nodeTest(["reference/test/gate1.test.mjs"], "^GATE-1:", { timeoutMs: 1_750_000 }) },
  { id: "GATE-2", m: "M1", kind: "-", level: 1, title: "pressure bites: 100% of denials carry Ludion-Error + help Link (+Accept-Signature)",
    run: nodeTest(["packages/gate-node/test/gate2.test.mjs"], "^GATE-2:") },
  { id: "GATE-3", m: "M1", kind: "+", level: 1, pair: "GATE-5", title: "install ≤3 app lines, ≤1 config file, first classified event ≤60s (3 reference apps)",
    timeoutMs: 1_800_000, run: nodeTest(["reference/test/gate3.test.mjs"], "^GATE-3:", { timeoutMs: 1_750_000,
      metric: (out) => [...out.matchAll(/^# (express|next|workers): (\d+) app lines, (\d+) config file, first event ([^\n]+)$/gm)].map((m) => `${m[1]} ${m[2]}L/${m[3]}cfg/${m[4]}`).join(", ") }) },
  { id: "GATE-4", m: "M1", kind: "+", level: 1, pair: "GATE-6", title: "added latency p99 ≤2ms warm (10k mixed requests)", timeoutMs: 180_000, run: async () => {
    // The real gate-node middleware timed per request, keys cached, every class in the mix; see the script.
    const r = sh(process.execPath, ["packages/gate-node/bench/gate4.mjs"], 170_000);
    let res;
    try { res = JSON.parse(r.out.trim().split("\n").pop()); } catch { return { pass: false, detail: r.out.trim().slice(-300) || "no result" }; }
    return { pass: r.code === 0 && res.pass === true, metric: `p50 ${res.p50}ms, p99 ${res.p99}ms (n=${res.n})`,
      detail: res.problems?.length ? res.problems.join("; ").slice(0, 300) : undefined };
  } },
  { id: "GATE-5", m: "M1", kind: "-", level: 1, title: "fail-open under fault injection at P0–1; fail_mode honoured at P2–3",
    run: nodeTest(["packages/gate-node/test/gate5.test.mjs"], "^GATE-5:") },
  { id: "GATE-6", m: "M1", kind: "-", level: 1, title: "SSRF sandbox: internal service receives 0 requests (incl. redirects, rebinding, bombs)",
    run: nodeTest(["packages/gate-node/test/gate6.test.mjs", "packages/gate-core/test/address.test.mjs"], "^GATE-6:") },
  { id: "GATE-7", m: "M1", kind: "-", level: 1, title: "attack corpus accept/attacks/ 100% rejected; corpus only grows",
    run: allOf(nodeScript("accept/attacks/run.mjs"), nodeTest(["packages/gate-core/test/hardening.test.mjs", "packages/gate-node/test/route-evasion.test.mjs", "packages/gate-node/test/authority.test.mjs", "packages/gate-core/test/nonce-flood.test.mjs"], "^GATE-7:")) },
  { id: "GATE-8", m: "M1", kind: "+", level: 1, pair: "GATE-7", title: "a real third-party signed request (fixture with provenance) is VERIFIED" },

  // ── M1 privacy ─────────────────────────────────────────────────────────────────
  { id: "PRIV-1", m: "M1", kind: "-", level: 1, title: "canary egress: 0 canaries, 0 raw IPs in any byte leaving the Gate (10k fuzzed)",
    run: nodeTest(["packages/gate-node/test/priv.test.mjs"], "^PRIV-1:") },
  { id: "PRIV-2", m: "M1", kind: "-", level: 1, title: "send_metadata=false → only key-directory fetches leave the process",
    run: nodeTest(["packages/gate-node/test/priv.test.mjs"], "^PRIV-2:") },
  { id: "PRIV-3", m: "M1", kind: "-", level: 1, title: "Registry receives no site origin/URL/path across the Diver lifecycle" },

  // ── M2 diver ───────────────────────────────────────────────────────────────────
  { id: "DIV-1", m: "M2", kind: "+", level: 1, pair: "DIV-3", title: "clean container → init → VERIFIED ≤180s (TS and Python)" },
  { id: "DIV-2", m: "M2", kind: "+", level: 1, pair: "DIV-3", title: "Card is a valid CIMD Signature Agent Card and resolves end to end",
    run: nodeTest(["packages/card-host/test/div2.test.mjs"], "^DIV-2:") },
  { id: "DIV-3", m: "M2", kind: "-", level: 1, title: "Root key never signs, never in the directory, never plaintext on disk outside dev",
    run: nodeTest(["packages/diver/test/div3.test.mjs"], "^DIV-3:") },
  { id: "DIV-4", m: "M2", kind: "±", level: 1, title: "session key rotation keeps the identifier; old key stops, new key works",
    run: nodeTest(["packages/diver/test/div4.test.mjs"], "^DIV-4:") },

  // ── M3 registry ────────────────────────────────────────────────────────────────
  { id: "REG-1", m: "M3", kind: "+", level: 1, pair: "REG-2", title: "Registry down → Gates keep verifying within Staple TTL",
    run: nodeTest(["services/registry/test/reg1.test.mjs"], "^REG-1:") },
  { id: "REG-2", m: "M3", kind: "-", level: 0, title: "Staple attacks rejected (unknown kid, >1h, expired, iss, cnf, sub)",
    run: nodeTest(["packages/gate-core/test/core.test.mjs"], "^Staple:") },
  { id: "REG-3", m: "M3", kind: "±", level: 1, title: "revocation reaches subscribed Gates ≤60s, others ≤ Staple TTL",
    run: nodeTest(["services/registry/test/reg3.test.mjs"], "^REG-3:", {
      metric: (out) => (/^# REG-3: (.+)$/m.exec(out) ?? [])[1] }) },
  { id: "REG-4", m: "M3", kind: "-", level: 1, title: "no private key material in git history, logs, or build artifacts",
    run: nodeScript("accept/keyscan/run.mjs") },

  // ── M4 fear → number ───────────────────────────────────────────────────────────
  { id: "SCAN-1", m: "M4", kind: "+", level: 1, pair: "SCAN-3", title: "scan parse rate ≥99% across the log-format corpus",
    run: nodeTest(["packages/scan/test/scan1.test.mjs"], "^SCAN-1:") },
  { id: "SCAN-2", m: "M4", kind: "+", level: 1, pair: "SCAN-3", title: "scan counts equal ground truth on labelled fixtures (incl. the critical-route number)",
    run: nodeTest(["packages/scan/test/scan2.test.mjs"], "^SCAN-2:") },
  { id: "SCAN-3", m: "M4", kind: "-", level: 1, title: "scan output has no raw IP / query value / untemplated path; zero network",
    run: nodeTest(["packages/scan/test/scan3.test.mjs"], "^SCAN-3:") },
  { id: "SCAN-4", m: "M4", kind: "+", level: 1, pair: "SCAN-3", title: "1 GB of logs in ≤60s", timeoutMs: 300_000, run: async () => {
    // 1 GiB generated in a temp dir (untimed), then the real CLI timed end to end; see the script.
    const r = sh(process.execPath, ["packages/scan/bench/scan4.mjs"], 290_000);
    let res;
    try { res = JSON.parse(r.out.trim().split("\n").pop()); } catch { return { pass: false, detail: r.out.trim().slice(-300) || "no result" }; }
    return { pass: r.code === 0 && res.pass === true, metric: `${res.seconds}s for 1 GiB, ${res.mbps} MB/s`,
      detail: res.problems?.length ? res.problems.join("; ").slice(0, 300) : undefined };
  } },
  { id: "RPT-1", m: "M4", kind: "+", level: 1, pair: "PRIV-1", title: "daily report equals ground truth; ja + en, HTML + text",
    run: nodeTest(["packages/report/test/rpt1.test.mjs"], "^RPT-1:") },

  // ── M5 pressure, neutrality, crypto ────────────────────────────────────────────
  { id: "PRS-1", m: "M5", kind: "±", level: 1, title: "100k random cases: UNKNOWN always passes; denials only at P≥2 on matching routes",
    run: nodeTest(["packages/gate-core/test/prs1.test.mjs"], "^PRS-1:") },
  { id: "PRS-2", m: "M5", kind: "±", level: 1, title: "Mandate v0: in scope/limit passes; out of scope/over limit/expired/revoked denied" },
  // The same portable suite on Node, Deno (no permissions) and workerd, against the npm-packed
  // packages; pinned runtimes in accept/neutral/runtime, installed in the OS temp dir (ADR-027).
  { id: "NEUT-1", m: "M5", kind: "+", level: 1, pair: "NEUT-2", title: "gate-core and Card Host pass the same suite on ≥2 independent runtimes",
    timeoutMs: 900_000, run: nodeScript("accept/neutral/runtimes.mjs", [], { timeoutMs: 880_000,
      metric: (out) => [...out.matchAll(/^ok (node|deno|workerd) (\S+).*?: (\d+)\/(\d+)/gm)].map((m) => `${m[1]} ${m[2]} ${m[3]}/${m[4]}`).join(", ") }) },
  // Lockfile-resolved tree of gate-core and Card Host: vendor names, vendor-org repositories, vendor
  // endpoints in code; standard reference implementations only by exact name@version (ADR-027).
  { id: "NEUT-2", m: "M5", kind: "-", level: 1, title: "no CDN/cloud vendor SDK in gate-core's dependency tree",
    run: nodeScript("accept/neutral/deps.mjs") },
  { id: "CRY-1", m: "M5", kind: "-", level: 0, title: "no home-made crypto: primitives only inside allowlisted modules", run: async () => {
    const allow = new Set(["packages/gate-core/src/staple.mjs", "packages/gate-core/src/receipt.mjs", "packages/diver/src/keys.mjs"]);
    // WebCrypto (also via a destructured `subtle`), node:crypto's cipher / KDF / signing / key
    // construction calls, and third-party primitive libraries. Hashing and randomness are fine.
    const banned = new RegExp([
      String.raw`\bsubtle\.(sign|verify|importKey|generateKey|deriveKey|deriveBits|encrypt|decrypt|wrapKey|unwrapKey)\b`,
      String.raw`\b(createCipheriv|createDecipheriv|scrypt|scryptSync|pbkdf2|pbkdf2Sync|hkdf|hkdfSync|createSign|createVerify|createPrivateKey|createPublicKey|createSecretKey|generateKeyPair|generateKeyPairSync|generateKeySync|diffieHellman|createDiffieHellman|createECDH|publicEncrypt|privateDecrypt|privateEncrypt|publicDecrypt)\s*\(`,
      String.raw`\bcrypto\.(sign|verify)\s*\(`,
      String.raw`import\s*\{[^}]*\b(sign|verify)\b[^}]*\}\s*from\s*["'](node:)?crypto["']`,
      String.raw`(from\s+|import\s*\(\s*|require\s*\(\s*)["'](tweetnacl|tweetnacl-util|elliptic|node-forge|crypto-js|@noble\/[\w-]+|libsodium[\w-]*|sodium-native|jsrsasign|node-rsa|sjcl)(\/[\w./-]*)?["']`,
    ].join("|"));
    const hits = [...walk(path.join(ROOT, "packages")), ...walk(path.join(ROOT, "services"))]
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/")).filter((f) => !/(^|\/)test\//.test(f) && !allow.has(f))
      .filter((f) => banned.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    return { pass: hits.length === 0, metric: `${allow.size} allowlisted`, detail: hits.length ? `outside allowlist: ${hits.join(", ")}` : undefined };
  } },

  // ── M6 the real world (needs human inputs) ─────────────────────────────────────
  { id: "LIVE-1", m: "M6", kind: "+", level: 2, pair: "GATE-5", needs: ["CLOUDFLARE_API_TOKEN"], title: "canary Gate (P0, *.workers.dev) up; hourly signed probe VERIFIED; ≥99.9%/week" },
  { id: "LIVE-2", m: "M6", kind: "+", level: 2, pair: "GATE-7", needs: ["LUDION_CANARY_READ_TOKEN"], title: "a real third-party agent is VERIFIED on the canary at least daily" },
  { id: "LIVE-3", m: "M6", kind: "+", level: 2, pair: "PRIV-1", needs: ["LUDION_CLOUD_READ_TOKEN"], title: "North Star: Verified Actions/day computed from Cloud events, on the scoreboard" },
];
