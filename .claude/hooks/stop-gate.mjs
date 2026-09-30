#!/usr/bin/env node
// Stop gate (human-owned). Only in unattended loops (LUDION_LOOP=1): Claude may not end a turn
// while level 0 is red or a ratcheted oracle regressed, unless docs/STATE.md carries a fresh BLOCKED
// note (the explicit way out). With a human present it never blocks. Claude Code itself caps
// consecutive stop-hook continuations at 8, so this cannot spin forever.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
try { fs.readFileSync(0, "utf8"); } catch {}
if (process.env.LUDION_LOOP !== "1") process.exit(0);
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let red = null;
try { execFileSync(process.execPath, ["scripts/scoreboard.mjs", "--fast", "--quiet"], { cwd, encoding: "utf8", timeout: 120_000 }); }
catch (e) { red = (`${e.stdout ?? ""}`.trim() || "level-0 oracle failing").slice(-1500); }
if (!red) process.exit(0);
try {
  const f = `${cwd}/docs/STATE.md`, st = fs.statSync(f), txt = fs.readFileSync(f, "utf8");
  const blocked = /^## BLOCKED\s*\n+(?!（なし）|\(none\))\S/m.test(txt);
  if (blocked && Date.now() - st.mtimeMs < 30 * 60_000) process.exit(0);
} catch {}
process.stdout.write(JSON.stringify({ decision: "block", reason:
  `Not done: ${red}\nFix it and rerun \`npm run scoreboard -- --fast\`. If you are genuinely stuck, write a BLOCKED entry in docs/STATE.md (hypotheses, what you tried, what a human must do), then stop.` }));
