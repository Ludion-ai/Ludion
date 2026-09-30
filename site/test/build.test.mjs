// The site build must work when the OS temp dir (where builds are cached) is on another drive
// than the checkout, as on the Windows CI runner (D:\a\… vs C:\Users\RUNNER~1\…). Astro renames
// files from site/.astro into its output directory, and a rename cannot cross devices (EXDEV:
// WEB-3 and WEB-4 failed on loop-windows after #45). So Astro only ever writes inside site/, and
// the result is moved to its destination, by copy when a rename cannot cross.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SITE, stageDir, moveDir } from "../build.mjs";

test("site build: Astro's output directory is inside site/, whatever the destination", () => {
  const dests = [path.join(os.tmpdir(), "ludion-site", "0123456789abcdef"), "Z:\\elsewhere\\dist", "/mnt/other/dist", path.join(SITE, "dist")];
  const stages = dests.map(stageDir);
  for (const s of stages) assert.ok(s.startsWith(SITE + path.sep) && path.parse(s).root === path.parse(SITE).root, s);
  assert.equal(new Set(stages).size, stages.length, "one stage per destination");
});

function tree(root) {
  fs.mkdirSync(path.join(root, "_astro"), { recursive: true });
  fs.mkdirSync(path.join(root, "ja", "e"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<html>en</html>");
  fs.writeFileSync(path.join(root, "_astro", "print.css"), "@media print{}");
  fs.writeFileSync(path.join(root, "ja", "e", "revoked.html"), "<html>ja</html>");
}
const list = (root) => fs.readdirSync(root, { recursive: true }).map((f) => String(f).split(path.sep).join("/")).sort();

test("site build: moving the output falls back to a copy when the rename crosses devices", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-build-"));
  try {
    const from = path.join(tmp, "stage"), to = path.join(tmp, "out", "dist");
    tree(from);
    const want = list(from);
    const exdev = () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); };
    moveDir(from, to, { rename: exdev });
    assert.deepEqual(list(to), want);
    assert.equal(fs.readFileSync(path.join(to, "ja", "e", "revoked.html"), "utf8"), "<html>ja</html>");
    assert.equal(fs.existsSync(from), false, "the stage is removed");
    // Any other rename error is not swallowed.
    tree(from);
    const eperm = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    assert.throws(() => moveDir(from, path.join(tmp, "out2"), { rename: eperm }), /EPERM/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("site build: on one device the move is a rename, and replaces what was there", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-build-"));
  try {
    const from = path.join(tmp, "stage"), to = path.join(tmp, "dist");
    tree(from);
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, "stale.html"), "old");
    let renamed = 0;
    moveDir(from, to, { rename: (a, b) => { renamed++; fs.renameSync(a, b); } });
    assert.equal(renamed, 1);
    assert.deepEqual(list(to), ["_astro", "_astro/print.css", "index.html", "ja", "ja/e", "ja/e/revoked.html"]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
