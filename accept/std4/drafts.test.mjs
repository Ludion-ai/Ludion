// STD-4, offline: the checker against a datatracker made of fixtures, and the real repository's
// references against the real pins. Each way a pin can go stale must fail, and only those.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, repoRefs, TRACKER } from "./drafts.mjs";
import { trackedFiles } from "./run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-01T00:00:00Z");
const A = "draft-ietf-webbotauth-httpsig-protocol", B = "draft-meunier-webbotauth-registry";
const PINS = { graceDays: 7, drafts: [{ name: A, rev: "00" }, { name: B, rev: "03" }] };
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const hist = (name, revs) => revs.map(([rev, days]) => ({ name, rev, published: ago(days), pages: 20 + Number(rev) }));
function doc(name, revs, state = "Active") {
  const h = hist(name, revs);
  return { name, rev: h.at(-1).rev, time: h.at(-1).published.replace("T", " ").slice(0, 19), pages: h.at(-1).pages, state, rev_history: h };
}
/** A datatracker made of documents and "replaces" relations; counts what was asked. */
function tracker(docs, replaces = {}, { down = false, status } = {}) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    if (down) throw new TypeError("fetch failed");
    if (status) return new Response("", { status });
    const u = new URL(url);
    let m = /^\/doc\/([^/]+)\/doc\.json$/.exec(u.pathname);
    if (m) return docs[m[1]] ? Response.json(docs[m[1]]) : new Response("", { status: 404 });
    if (u.pathname === "/api/v1/doc/relateddocument/") {
      const src = replaces[u.searchParams.get("target__name")];
      return Response.json({ objects: src ? [{ source: `/api/v1/doc/document/${src}/`, target: `/api/v1/doc/document/${u.searchParams.get("target__name")}/` }] : [] });
    }
    return new Response("", { status: 404 });
  };
  return { fetch, asked };
}
const run = (t, o = {}) => check({ pins: PINS, files: [], fetch: t.fetch, now: NOW, attempts: 2, backoffMs: 0, ...o });
const current = () => ({ [A]: doc(A, [["00", 30]]), [B]: doc(B, [["02", 120], ["03", 90]]) });

test("STD-4: pins that are the latest revision pass", async () => {
  const r = await run(tracker(current()));
  assert.equal(r.pass, true, r.detail); assert.equal(r.issues.length, 0);
  assert.match(r.metric, /all latest/);
});

test("STD-4: a newer revision gives an issue and grace days, then fails", async () => {
  const docs = current();
  docs[A] = doc(A, [["00", 30], ["01", 3], ["02", 1]]);
  let r = await run(tracker(docs));
  assert.equal(r.pass, true, "3 days after -01 appeared: within the grace days");
  assert.equal(r.issues.length, 1);
  const i = r.issues[0];
  assert.equal(i.title, `STD-4: follow ${A}-02 (pinned ${A}-00)`);
  assert.match(i.body, new RegExp(`First newer: ${A}-01, published .* \\(3 days ago\\)`), "the clock starts at the first newer revision");
  assert.match(i.body, new RegExp(`iddiff\\?url1=${A}-00&url2=${A}-02`), "with the diff to read");
  assert.equal(i.due.toISOString().slice(0, 10), "2026-10-05");
  docs[A] = doc(A, [["00", 30], ["01", 8]]);
  r = await run(tracker(docs));
  assert.equal(r.pass, false, "8 days: overdue"); assert.match(r.detail, /more than 7 days/);
});

test("STD-4: a replaced draft is followed to its successor", async () => {
  const docs = current();
  docs[B] = doc(B, [["02", 120], ["03", 90]], "Replaced");
  docs["draft-ietf-webbotauth-registry"] = doc("draft-ietf-webbotauth-registry", [["00", 2]]);
  const t = tracker(docs, { [B]: "draft-ietf-webbotauth-registry" });
  let r = await run(t);
  assert.equal(r.pass, true, "adopted 2 days ago");
  assert.match(r.issues[0].body, new RegExp(`${B} → draft-ietf-webbotauth-registry: replaced`));
  assert.match(r.issues[0].title, /follow draft-ietf-webbotauth-registry-00/);
  docs["draft-ietf-webbotauth-registry"] = doc("draft-ietf-webbotauth-registry", [["00", 10], ["01", 1]], "Replaced");
  docs["draft-ietf-webbotauth-card"] = doc("draft-ietf-webbotauth-card", [["00", 1]]);
  r = await run(tracker(docs, { [B]: "draft-ietf-webbotauth-registry", "draft-ietf-webbotauth-registry": "draft-ietf-webbotauth-card" }));
  assert.equal(r.pass, false, "10 days since the adoption, whatever happened after");
  assert.match(r.issues[0].title, /follow draft-ietf-webbotauth-card-00/, "followed to the end of the chain");
  docs[B] = doc(B, [["03", 90]], "Replaced");
  r = await run(tracker(docs, {}));
  assert.equal(r.pass, false, "Replaced with no successor named is not knowable"); assert.match(r.detail, /names no successor/);
});

test("STD-4: what cannot be known fails; a pin ahead of the datatracker fails", async () => {
  for (const [what, t, re] of [
    ["down", tracker(current(), {}, { down: true }), /fetch failed/],
    ["5xx", tracker(current(), {}, { status: 503 }), /HTTP 503/],
    ["unknown draft", tracker({ [B]: current()[B] }), /does not know this draft/],
  ]) {
    const r = await run(t);
    assert.equal(r.pass, false, what); assert.match(r.detail, re, what);
  }
  const t = tracker(current(), {}, { down: true });
  await run(t);
  assert.equal(t.asked.filter((u) => u.includes(A)).length, 2, "retried before giving up");
  const r = await check({ pins: { graceDays: 7, drafts: [{ name: A, rev: "01" }] }, files: [], fetch: tracker(current()).fetch, now: NOW, attempts: 1, backoffMs: 0 });
  assert.equal(r.pass, false); assert.match(r.detail, /ahead of the datatracker/);
  const empty = await check({ pins: { drafts: [] }, files: [], fetch: tracker(current()).fetch, now: NOW });
  assert.equal(empty.pass, false, "nothing pinned is not a pass");
  assert.ok(t.asked.every((u) => u.startsWith(TRACKER)), "only the datatracker is asked");
});

test("STD-4: repository references name the pinned drafts at the pinned revisions", () => {
  const files = [
    { path: "packages/x/a.mjs", text: `// ${A}-00 §5.2 and ${B}-03; plain ${A} without a revision; draft-ietf-httpbis-message-signatures-19 is not ours` },
    { path: "docs/ludion-spec.md", text: `${A}-01` },
    { path: "docs/MISSION.md", text: `draft-meunier-web-bot-auth-architecture-05` },
    { path: "docs/adr/2026-01-01-old.md", text: `${A}-99 (history)` },
    { path: "docs/STATE.md", text: `${B}-01` },
  ];
  const r = repoRefs(files, PINS.drafts);
  assert.equal(r.refs, 4);
  assert.deepEqual(r.problems, [
    `docs/ludion-spec.md: ${A}-01, but the pin is -00`,
    "docs/MISSION.md: draft-meunier-web-bot-auth-architecture-05 is a Web Bot Auth draft that is not pinned",
  ]);
});

test("STD-4: the repository is read as CI reads it: new files too, ignored files and the checker's own fixtures not", () => {
  // Found in CI (#53): a local run before the commit did not see the new test file, whose
  // fixtures then failed the check on the runner.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-std4-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.md\n");
    fs.mkdirSync(path.join(dir, "accept", "std4"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tracked.md"), `${A}-00`);
    fs.writeFileSync(path.join(dir, "new.md"), `${A}-01`);
    fs.writeFileSync(path.join(dir, "ignored.md"), `${A}-02`);
    fs.writeFileSync(path.join(dir, "accept", "std4", "x.test.mjs"), `${A}-03`);
    git("add", "tracked.md", ".gitignore");
    const files = trackedFiles(dir);
    assert.deepEqual(files.map((f) => f.path).sort(), ["accept/std4/x.test.mjs", "new.md", "tracked.md"], "tracked and new text files, not the ignored one");
    assert.deepEqual(repoRefs(files, PINS.drafts).problems, [`new.md: ${A}-01, but the pin is -00`], "the new file counts; the ignored one and accept/std4/ do not");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("STD-4: this repository agrees with its pins", () => {
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, "accept/std4/pins.json"), "utf8"));
  const r = repoRefs(trackedFiles(ROOT), pins.drafts);
  assert.deepEqual(r.problems, []);
  assert.ok(r.refs >= 10, `references found: ${r.refs}`);
});
