// RPT-1 (+, pair PRIV-1): the daily report built from recorded metadata events equals the ground
// truth, in Japanese and English, as HTML and as plain text.
//
// "Equals" is checked number by number: every number in every rendering is parsed back out and
// compared with the truth, and a number the test does not know is a failure. The truth comes
// from accept/fixtures/report/generate.mjs (hand-labelled tables), never from the report code.
// The report runs as the real CLI in a child process with every network API trapped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { leaks, untemplated } from "../../scan/test/support.mjs";
import { dayWindow } from "@ludion/report";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const FIX = path.join(ROOT, "accept/fixtures/report");
const CLI = path.join(ROOT, "packages/diver/bin/ludion.mjs");
const TRAP = pathToFileURL(path.join(ROOT, "packages/scan/test/no-network.mjs")).href;
const LANGS = ["ja", "en"];

const CASES = fs.readdirSync(path.join(FIX, "truth")).filter((f) => f.endsWith(".truth.json")).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIX, "truth", f), "utf8")));
const CANARIES = JSON.parse(fs.readFileSync(path.join(FIX, "truth", "canaries.json"), "utf8"));

const netLogs = [];
/** `ludion report …` in a child process, network trapped. */
function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-rpt1-"));
  const log = path.join(dir, "net.log");
  fs.writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", TRAP, CLI, "report", ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, LUDION_NET_TRAP: log }, maxBuffer: 64e6, timeout: 60_000,
  });
  netLogs.push({ args: args.join(" "), net: fs.readFileSync(log, "utf8").split("\n").filter(Boolean) });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const outputs = new Map();
function output(t, lang, format) {
  const k = `${t.case} ${lang} ${format}`;
  if (!outputs.has(k)) {
    const r = run(["--events", path.join(FIX, t.events_file), "--site", t.site, "--date", t.date, "--tz", t.tz, "--lang", lang, "--format", format]);
    assert.equal(r.code, 0, `${k}: exit ${r.code} ${r.stderr}`);
    outputs.set(k, r.stdout);
  }
  return outputs.get(k);
}

// ── what the truth says every rendering must show ──────────────────────────────────────────
/** key → number, and key → name, from the truth alone (the test's own list, not the renderer's). */
function expected(t) {
  const x = t.expect, nums = new Map(), names = new Map();
  for (const k of ["unverified", "allowed", "friction", "denied"]) nums.set(`critical.${k}`, x.critical[k]);
  nums.set("verified_actions", x.verified_actions);
  nums.set("verified_agents", x.verified_agents);
  nums.set("events", x.events);
  for (const [c, v] of Object.entries(x.classes)) nums.set(`classes.${c}`, v);
  for (const [d, v] of Object.entries(x.decisions)) nums.set(`decisions.${d}`, v);
  for (const [k, v] of Object.entries(x.kinds)) for (const m of ["automation", "verified", "denied"]) nums.set(`kinds.${k}.${m}`, v[m]);
  x.top_agents.forEach((a, i) => { nums.set(`top_agents.${i}.actions`, a.actions); names.set(`top_agents.${i}.agent`, a.agent); });
  x.top_critical_routes.forEach((r, i) => { nums.set(`top_critical_routes.${i}.count`, r.count); names.set(`top_critical_routes.${i}.route`, r.route); });
  if (x.pressure1.applies) { nums.set("pressure1.friction", x.pressure1.friction); nums.set("pressure1.exempt", x.pressure1.exempt); }
  if (x.previous) for (const m of Object.keys(x.previous)) { nums.set(`previous.${m}`, x.previous[m]); nums.set(`delta.${m}`, x.delta[m]); }
  if (x.skipped) nums.set("skipped", x.skipped);
  return { nums, names };
}

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const parseNum = (s) => {
  const m = /^([+\-±]?)(\d[\d,]*)$/.exec(s.trim());
  assert.ok(m, `not a number: ${JSON.stringify(s)}`);
  const n = Number(m[2].replace(/,/g, ""));
  assert.ok(!/^0\d/.test(m[2]) && (!m[2].includes(",") || /^\d{1,3}(,\d{3})*$/.test(m[2])), `badly grouped: ${s}`);
  return m[1] === "-" ? -n : n;
};

/** Every number in free text, after removing the strings that may carry digits without being metrics. */
function numbersIn(text, t) {
  let s = text;
  const literal = [t.site, t.date, ...t.expect.top_agents.map((a) => a.agent), ...t.expect.top_critical_routes.map((r) => r.route)]
    .sort((a, b) => b.length - a.length);
  for (const l of literal) s = s.split(l).join(" ");
  s = s.replace(/\bPressure [0-3]\b/g, " ");
  return [...s.matchAll(/[+\-±]?\d[\d,]*/g)].map((m) => parseNum(m[0]));
}

function htmlMetrics(html) {
  return [...html.matchAll(/<td data-metric="([^"]+)"[^>]*>([^<]*)<\/td>/g)].map((m) => [decode(m[1]), parseNum(decode(m[2]))]);
}
function htmlNames(html) {
  return [...html.matchAll(/<td data-name="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => [decode(m[1]), decode(m[2].replace(/<[^>]*>/g, ""))]);
}
const htmlText = (html) => decode(html.replace(/<title>[\s\S]*?<\/title>/, " ").replace(/<[^>]*>/g, " "));

// ── the oracle ────────────────────────────────────────────────────────────────────────────
test("RPT-1: the fixture is exactly what its generator writes, and covers the hard cases", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-rpt1-gen-"));
  try {
    const r = spawnSync(process.execPath, [path.join(FIX, "generate.mjs"), "--out", tmp], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const sub of ["events", "truth"]) {
      const want = fs.readdirSync(path.join(tmp, sub)).sort();
      assert.deepEqual(fs.readdirSync(path.join(FIX, sub)).sort(), want, `${sub}/ has exactly the generated files`);
      for (const f of want) assert.ok(fs.readFileSync(path.join(FIX, sub, f)).equals(fs.readFileSync(path.join(tmp, sub, f))), `${sub}/${f} is not what generate.mjs writes`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.ok(CASES.length >= 4);
  assert.ok(CASES.some((t) => t.tz === "Asia/Tokyo"), "a JST day");
  const dst = CASES.find((t) => t.tz === "America/New_York");
  assert.ok(dst && Date.parse(dst.window.end) - Date.parse(dst.window.start) === 25 * 3600_000, "a 25-hour DST day");
  assert.ok(CASES.some((t) => t.expect.previous === null) && CASES.some((t) => t.expect.previous), "with and without a previous day");
  for (const t of CASES) {
    assert.ok(t.expect.skipped > 0, "unreadable lines in the input");
    assert.ok(Object.values(t.expect.delta ?? {}).length === 0 || Object.values(t.expect.delta).some((d) => d !== 0));
  }
  const a = CASES.find((t) => t.tz === "Asia/Tokyo").expect;
  for (const [c, v] of Object.entries(a.classes)) assert.ok(v > 0, `class ${c} present`);
  assert.ok(a.critical.allowed > 0 && a.critical.friction > 0 && a.critical.denied > 0, "critical touches allowed, challenged and refused");
  assert.ok(a.top_agents.some((x) => x.agent === "(unnamed)"), "an identifier that must not be shown by name");
  assert.ok(a.top_critical_routes.some((x) => x.route === "/checkout/:token") && a.top_critical_routes.some((x) => x.route === "/:param/login"),
    "dirty raw routes reach the busiest-routes list (so their templating is exercised)");
});

test("RPT-1: the summary (JSON) equals the ground truth", () => {
  for (const t of CASES) {
    const s = JSON.parse(output(t, "en", "json"));
    assert.equal(s.site, t.site); assert.equal(s.date, t.date); assert.equal(s.tz, t.tz);
    assert.deepEqual(s.window, t.window, `${t.case}: day window in ${t.tz}`);
    for (const [k, v] of Object.entries(t.expect)) assert.deepEqual(s[k], v, `${t.case}: ${k}`);
    const allowed = new Set(["report", "v", "site", "date", "tz", "window", ...Object.keys(t.expect)]);
    assert.deepEqual(Object.keys(s).filter((k) => !allowed.has(k)), [], `${t.case}: no other fields`);
  }
});

test("RPT-1: every number in all four renderings equals the truth, and ja and en carry the same numbers", () => {
  for (const t of CASES) {
    const { nums, names } = expected(t);
    const seqs = {};
    for (const lang of LANGS) {
      const at = `${t.case} ${lang}`;
      const html = output(t, lang, "html"), text = output(t, lang, "text"), subj = output(t, lang, "subject").trim();
      // HTML: every tagged number is a known metric with the true value; nothing is missing or doubled.
      const ms = htmlMetrics(html);
      assert.deepEqual(ms.map(([k]) => k).filter((k, i, a) => a.indexOf(k) !== i), [], `${at}: a metric shown twice`);
      assert.deepEqual(ms.map(([k]) => k).filter((k) => !nums.has(k)), [], `${at}: numbers the truth does not know`);
      assert.deepEqual([...nums.keys()].filter((k) => !ms.some(([m]) => m === k)), [], `${at}: metrics missing`);
      for (const [k, v] of ms) assert.equal(v, nums.get(k), `${at}: ${k}`);
      const ns = htmlNames(html);
      assert.deepEqual(ns, [...names], `${at}: agent and route names, in order`);
      // HTML: no number outside the tagged cells.
      assert.deepEqual(numbersIn(htmlText(html), t), ms.map(([, v]) => v), `${at}: an untagged number in the HTML`);
      // Text: exactly the same numbers, in the same order.
      assert.deepEqual(numbersIn(text, t), ms.map(([, v]) => v), `${at}: text and HTML disagree`);
      for (const [, name] of names) assert.ok(text.includes(name), `${at}: text lacks ${name}`);
      // Subject: the fear number, then verified actions; the HTML title is the subject.
      assert.deepEqual(numbersIn(subj, t), [t.expect.critical.unverified, t.expect.verified_actions], `${at}: subject`);
      assert.ok(subj.includes(t.site) && subj.includes(t.date), `${at}: subject names the site and day`);
      assert.equal(decode(/<title>([\s\S]*?)<\/title>/.exec(html)[1]), subj, `${at}: HTML title is the subject`);
      seqs[lang] = ms;
    }
    assert.deepEqual(seqs.ja, seqs.en, `${t.case}: ja and en carry different numbers`);
  }
});

test("RPT-1: the HTML is self-contained and email-safe", () => {
  for (const t of CASES) for (const lang of LANGS) {
    const at = `${t.case} ${lang}`, html = output(t, lang, "html");
    assert.match(html, /^<!doctype html>\n<html lang="(ja|en)">/, `${at}: doctype and lang`);
    assert.ok(html.includes(`<html lang="${lang}">`) && html.includes(`<meta charset="utf-8">`), `${at}: lang and charset`);
    assert.doesNotMatch(html, /<(script|style|link|iframe|frame|object|embed|img|picture|form|input|button|select|textarea|video|audio|source|track|svg|canvas|base)\b/i, `${at}: forbidden element`);
    assert.doesNotMatch(html, /<meta\s+http-equiv/i, `${at}: meta refresh`);
    assert.doesNotMatch(html, /\s(src|srcset|background|action|formaction|poster|on[a-z]+)\s*=/i, `${at}: resource or handler attribute`);
    assert.doesNotMatch(html, /url\(|@import|expression\(|javascript:|vbscript:|(^|[^a-z-])data:/i, `${at}: external or scripted content`);
    assert.doesNotMatch(html, /=\s*"\/\//, `${at}: protocol-relative URL`);
    for (const m of html.matchAll(/href="([^"]*)"/g)) assert.match(m[1], /^https:\/\/ludion\.ai\/[a-z0-9/-]*$/, `${at}: link ${m[1]} (no query, no tracking)`);
    assert.doesNotMatch(html, /<(body|table|td|th|div)\b(?![^>]*\bstyle=)[^>]*>/, `${at}: an element without inline style`);
  }
});

test("RPT-1: nothing identifying reaches any rendering", () => {
  const canaries = { ip: CANARIES.ip, value: CANARIES.value, host: CANARIES.host, rid: CANARIES.rid, ip_h: CANARIES.ip_h };
  assert.ok(CANARIES.rid.length > 1000 && CANARIES.ip_h.length > 1000, "every receipt id and IP hash is a canary");
  for (const t of CASES) {
    for (const lang of LANGS) for (const f of ["text", "html", "subject"]) {
      assert.deepEqual(leaks(output(t, lang, f), canaries), [], `${t.case} ${lang} ${f}: leaked`);
    }
    const json = output(t, "en", "json");
    assert.deepEqual(leaks(json, canaries), [], `${t.case} json: leaked`);
    const s = JSON.parse(json);
    for (const r of s.top_critical_routes) assert.ok(!untemplated(r.route), `${t.case}: untemplated route ${r.route}`);
    for (const lang of LANGS) {
      for (const [k, v] of htmlNames(output(t, lang, "html"))) if (k.endsWith(".route")) assert.ok(!untemplated(v), `${t.case} ${lang}: untemplated route ${v}`);
    }
    for (const a of s.top_agents) assert.match(a.agent, /^(\(unnamed\)|dvr-[a-z0-9]+|[a-z0-9-]+(\.[a-z0-9-]+)+)$/, `${t.case}: agent name ${a.agent}`);
  }
});

test("RPT-1: the report makes zero network calls", () => {
  for (const t of CASES) for (const lang of LANGS) for (const f of ["text", "html", "subject", "json"]) output(t, lang, f);
  assert.ok(netLogs.length >= CASES.length * 7);
  for (const n of netLogs) assert.deepEqual(n.net, ["armed"], `network attempted: ${n.args}`);
});

test("RPT-1: the CLI refuses what it cannot answer", () => {
  const ev = path.join(FIX, CASES[0].events_file);
  const two = run(["--events", ev, "--date", "2026-09-29"]);
  assert.equal(two.code, 2); assert.match(two.stderr, /2 sites; choose one with --site/);
  assert.equal(run(["--events", ev, "--site", CASES[0].site, "--date", "2026-02-30"]).code, 2);
  assert.equal(run(["--events", ev, "--site", CASES[0].site, "--date", "2026-09-29", "--tz", "Mars/Olympus"]).code, 2);
  assert.equal(run(["--events", ev, "--site", CASES[0].site, "--date", "2026-09-29", "--lang", "fr"]).code, 2);
  assert.equal(run(["--events", path.join(FIX, "no-such-file.ndjson"), "--date", "2026-09-29"]).code, 2);
  // Day windows follow the zone: 23 and 25 hours at the DST changes, 24 in JST.
  const h = (d, tz) => { const w = dayWindow(d, tz); return (w.end - w.start) / 3600_000; };
  assert.equal(h("2026-03-08", "America/New_York"), 23);
  assert.equal(h("2026-11-01", "America/New_York"), 25);
  assert.equal(h("2026-09-29", "Asia/Tokyo"), 24);
  assert.equal(new Date(dayWindow("2026-09-29", "Asia/Tokyo").start).toISOString(), "2026-09-28T15:00:00.000Z");
});
