// sqliteLedger opened by many Gate processes at once (PRS-3). A site starts its processes together,
// so the first open of a new ledger file races: every process must open it and count, none may
// die on "database is locked". Found in CI (PR #72, loop-windows): two PRS-3 Gate processes
// starting together, one of them gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const OPEN = `import { sqliteLedger } from "@ludion/gate-node";
const go = Number(process.argv[2]);
while (Date.now() < go) await new Promise((r) => setTimeout(r, 1)); // all open at the same moment
try { const l = await sqliteLedger(process.argv[1]); const r = await l.charge({ jti: "mdt-open-race", limits: { per_day: 1000 } }, { at: Date.now() }); console.log(r.ok ? "ok" : "refused " + r.reason); }
catch (e) { console.log("ERR " + e.message); }`;

function opener(file, go) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", OPEN, file, String(go)], { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("exit", () => resolve(out.trim()));
  });
}

test("PRS-3: eight Gate processes opening one new ledger file at once all open it and count, every time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-ledger-open-"));
  try {
    for (let round = 0; round < 4; round++) {
      const file = path.join(dir, `ledger-${round}.db`);
      const go = Date.now() + 2000; // started one by one, they all wait for this moment
      const outs = await Promise.all(Array.from({ length: 8 }, () => opener(file, go)));
      assert.deepEqual(outs.filter((o) => o !== "ok"), [], `round ${round}: ${JSON.stringify(outs)}`);
    }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } }
});
