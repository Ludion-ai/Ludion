// Writes the sample lessons used to check the design (docs/decisions.md, Site). Never part of lessons/ or production.
// Run: node apps/site/samples/generate.ts  (rewrites samples/lessons and samples/meta.json)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatLesson, type LessonV0 } from "@ludion/core";

const out = fileURLToPath(new URL(".", import.meta.url));

// Fictional teachers. Their ids are fake, so the site shows monogram avatars for them, never GitHub's.
const teachers: Record<number, string> = {
  101: "alice-chen",
  102: "kenji-watanabe",
  103: "maximilian-alexander-von-hohenzollern-x",
  104: "rn",
};

type Sample = Omit<LessonV0, "id" | "author" | "author_id" | "created_at"> & { teacher: number; day: number; key: string; pr: number };

const LONG =
  "git switch and git restore, added in Git 2.23, split the two jobs of git checkout: switch changes branches and refuses to throw away local changes unless you pass --discard-changes, while restore brings back file contents from the index or from a commit without moving HEAD. Scripts that call git checkout with a path keep working, but the newer documentation teaches the two narrower commands first.";

const samples: Sample[] = [
  { key: "cgi", teacher: 102, day: 8, pr: 61, subject: "python", version: ">=3.13", claim: "Python 3.13 removed cgi.",
    evidence: [{ source: { url: "https://peps.python.org/pep-0594/", quote: "Remove the cgi module" } }] },
  { key: "ws", teacher: 101, day: 8, pr: 60, subject: "node", version: ">=22", claim: "Node.js 22 has a global WebSocket client, enabled by default; no package is needed.",
    evidence: [{ run: { runner: "node", code: "if (typeof WebSocket !== 'function') process.exit(1);\nconsole.log('ok');" } }] },
  { key: "lean", teacher: 103, day: 7, pr: 58, subject: "lean", claim: "In Lean 4, n + 0 = n holds for every natural number n by definition, so rfl proves it.",
    evidence: [{ run: { runner: "lean", code: "theorem add_zero' (n : Nat) : n + 0 = n := rfl" } }] },
  { key: "long", teacher: 101, day: 7, pr: 57, subject: "git", version: ">=2.23", claim: LONG,
    evidence: [
      { run: { runner: "bash", code: "git switch --help >/dev/null 2>&1 || exit 1\ngit restore --help >/dev/null 2>&1 || exit 1\necho ok" } },
      { source: { url: "https://git-scm.com/docs/git-switch", quote: "THIS COMMAND IS EXPERIMENTAL. THE BEHAVIOR MAY CHANGE." } },
    ] },
  { key: "ts-old", teacher: 104, day: 2, pr: 41, subject: "typescript", version: ">=5.0", claim: "TypeScript 5.0 made moduleResolution bundler the default for new projects.",
    evidence: [{ source: { url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/", quote: "--moduleResolution bundler" } }] },
  { key: "ts-new", teacher: 102, day: 6, pr: 55, subject: "typescript", version: ">=5.0", claim: "TypeScript 5.0 added moduleResolution bundler, but tsc --init does not choose it for you.",
    evidence: [{ source: { url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/", quote: "--moduleResolution bundler" } }], replaces: ["ts-old"] },
  { key: "rl", teacher: 101, day: 6, pr: 54, subject: "cloudflare-workers", claim: "Workers Rate Limiting bindings accept a period of 10 or 60 seconds, nothing else.",
    evidence: [{ source: { url: "https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/", quote: "The period must be either 10 or 60 seconds" } }] },
  { key: "sortv", teacher: 103, day: 5, pr: 50, subject: "coreutils", claim: "GNU sort -V puts version 1.10 after 1.9, unlike plain sort.",
    evidence: [{ run: { runner: "bash", code: "out=$(printf '1.10\\n1.9\\n' | sort -V | tr '\\n' ' ')\n[ \"$out\" = '1.9 1.10 ' ] || exit 1" } }] },
  { key: "rust", teacher: 104, day: 4, pr: 47, subject: "rust", version: "edition 2024", claim: "In the Rust 2024 edition, extern blocks must be written unsafe extern.",
    evidence: [{ source: { url: "https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-extern.html", quote: "extern blocks must now be marked with the unsafe keyword" } }] },
  { key: "dict", teacher: 102, day: 3, pr: 44, subject: "python", version: ">=3.7", claim: "dict keeps insertion order as a language guarantee since Python 3.7, not just in CPython.",
    evidence: [{ run: { runner: "python", code: "d = {}\nfor k in 'zyx':\n    d[k] = 1\nassert list(d) == ['z', 'y', 'x']" } }] },
  { key: "has", teacher: 103, day: 3, pr: 43, subject: "css", claim: "The CSS :has() selector works in every major browser engine.",
    evidence: [{ source: { url: "https://developer.mozilla.org/en-US/docs/Web/CSS/:has", quote: "This feature is well established and works across many devices" } }] },
  { key: "sqlite", teacher: 101, day: 1, pr: 40, subject: "sqlite", version: ">=3.35", claim: "SQLite supports RETURNING on INSERT, UPDATE, and DELETE since version 3.35.",
    evidence: [{ run: { runner: "python", code: "import sqlite3\nc = sqlite3.connect(':memory:')\nc.execute('create table t (x)')\nassert c.execute('insert into t values (1) returning x').fetchone() == (1,)" } }] },
];

// Stable ULIDs: time from the day, randomness replaced by the key so reruns produce the same files.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function sampleId(ms: number, key: string): string {
  let time = "";
  for (let t = ms, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let rest = "";
  for (let i = 0; i < 16; i++) rest += CROCKFORD[(key.charCodeAt(i % key.length) * (i + 7)) % 32];
  return time + rest;
}

const ids = new Map<string, string>();
for (const s of samples) ids.set(s.key, sampleId(Date.UTC(2026, 9, s.day, 9, s.pr), s.key));

rmSync(`${out}lessons`, { recursive: true, force: true });
const git: Record<string, { verified_at: string; pr: number }> = {};
for (const s of samples) {
  const id = ids.get(s.key)!;
  const created = new Date(Date.UTC(2026, 9, s.day, 9, s.pr));
  const lesson: LessonV0 = {
    id,
    subject: s.subject,
    ...(s.version ? { version: s.version } : {}),
    claim: s.claim,
    evidence: s.evidence,
    author: `github:${teachers[s.teacher]}`,
    author_id: s.teacher,
    ...(s.replaces ? { replaces: s.replaces.map((k) => ids.get(k)!) } : {}),
    created_at: created.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  mkdirSync(`${out}lessons/${s.subject}`, { recursive: true });
  writeFileSync(`${out}lessons/${s.subject}/${id}.json`, formatLesson(lesson));
  git[id] = { verified_at: new Date(created.getTime() + 47 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"), pr: s.pr };
}
writeFileSync(`${out}meta.json`, JSON.stringify({ teachers, git }, null, 2) + "\n");
console.log(`Wrote ${samples.length} sample lessons. Longest claim: ${Math.max(...samples.map((s) => s.claim.length))} characters.`);
