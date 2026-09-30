#!/usr/bin/env node
// SessionStart (human-owned): put the scoreboard in front of Claude before anything else.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let text;
if (!fs.existsSync(`${cwd}/node_modules`)) text = "Dependencies are not installed. Run `npm ci` first, then `npm run scoreboard`.";
else {
  try { text = execFileSync(process.execPath, ["scripts/scoreboard.mjs", "--fast", "--brief"], { cwd, encoding: "utf8", timeout: 90_000 }); }
  catch (e) { text = `${e.stdout ?? ""}\n(scoreboard exited ${e.status}: a ratcheted oracle regressed or level 0 is red; that comes first)`; }
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart",
  additionalContext: `${text}\nContinue from docs/STATE.md "次の一手". The backlog is the FAIL/PENDING list above; there is no other.` } }));
