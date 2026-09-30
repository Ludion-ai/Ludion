#!/usr/bin/env node
// STD-4 runner: the pins (accept/std4/pins.json) against the IETF datatracker and against every
// tracked text file. Prints `ok` / `not ok` lines, the issue text for any draft that moved, and a
// last line `STD-4: <metric>`. Exit 1 on failure. Needs the network (level 2).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check } from "./drafts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pins = JSON.parse(fs.readFileSync(path.join(ROOT, "accept/std4/pins.json"), "utf8"));

/**
 * The repository's text files as CI will see them: tracked, and also new files not yet added (a
 * local run before the commit must read what CI will read), never what .gitignore ignores.
 * drafts.mjs skips ADRs, STATE.md, the outbox and accept/std4/.
 */
export function trackedFiles(root = ROOT) {
  const list = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64e6 }).split("\0").filter(Boolean);
  return list.filter((p) => /\.(m?[jt]sx?|cjs|json|md|mdx|astro|ya?ml|toml|py|php|go|rs|txt|html)$/.test(p) && !/(^|\/)(package-lock\.json|node_modules\/)/.test(p))
    .flatMap((p) => { try { return [{ path: p, text: fs.readFileSync(path.join(root, p), "utf8") }]; } catch { return []; } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await check({ pins, files: trackedFiles(), fetch: globalThis.fetch, now: Date.now() });
  for (const l of r.lines) console.log(l);
  for (const i of r.issues) console.log(`\n--- issue: ${i.title}\n${i.body}\n---`);
  console.log(`STD-4: ${r.metric}`);
  if (!r.pass) { console.log(r.detail); process.exit(1); }
}
