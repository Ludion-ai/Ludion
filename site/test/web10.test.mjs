// WEB-10 (+): the quickstart runs as written. site/src/content/docs/quickstart.mdx is read the way a
// reader meets it: its fenced blocks in order. A `sh` block is run with bash in the reader's
// directory, a block with a title is written as the file it names, and a `text` block is what the
// command before it must print ("…" stands for the rest of a value). The prose that makes a claim the
// blocks do not show is checked too (a browser gets UNKNOWN and the same page; init writes the files
// it lists; the signed request is VERIFIED).
//
// What stands in for the world, and nothing else:
//   - @ludion/* and `npx ludion` resolve to the npm publish set's tarballs (accept/publish/set.mjs),
//     as they will from npm; everything else comes from the npm registry.
//   - `node server.mjs` is started in the background (the reader keeps it running).
//   - agent.example.com is not ours, so the directory `init` writes is not served there. The signed
//     request still goes to the quickstart's Gate, which cannot fetch the directory and says so
//     (UNVERIFIED), and the very same request is then checked by a Gate given the directory file
//     `init` wrote: the bytes a Gate fetches once the reader publishes them. That one must say
//     VERIFIED, and a tampered copy must not.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, packAll, SET, manifest } from "../../accept/publish/set.mjs";

const PAGE = path.join(ROOT, "site/src/content/docs/quickstart.mdx");
const PORT = 3000;
const PASSPHRASE = "web-10 quickstart passphrase";

/** The page's fenced blocks in order, each with the `##` section it is in. */
export function blocks(mdx) {
  const out = [];
  let section = null;
  for (const m of mdx.matchAll(/^## (.+)$|^```(\w+)(?: title="([^"]+)")?\r?\n([\s\S]*?)^```\s*$/gm)) {
    if (m[1]) { section = m[1].trim(); continue; }
    out.push({ section, lang: m[2], title: m[3] ?? null, code: m[4].replace(/\r\n/g, "\n") });
  }
  return out;
}

/** Does `actual` print what the page shows? Line by line; "…" ends a line's literal part. */
export function printsAsShown(actual, shown) {
  const got = actual.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const want = shown.trimEnd().split("\n");
  if (got.length !== want.length) return false;
  return want.every((w, i) => (w.endsWith("…") ? got[i].startsWith(w.slice(0, -1)) && got[i].length > w.length - 1 : got[i] === w));
}

function bash() {
  if (process.platform !== "win32") return "bash";
  for (const p of [process.env.LUDION_BASH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) if (p && fs.existsSync(p)) return p;
  throw new Error("WEB-10 runs the page's shell blocks with bash: install Git for Windows or set LUDION_BASH");
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});

function killTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
}

let tmp, tarballs, env, server;
const posix = (p) => p.replace(/\\/g, "/");

/** Run one shell block as the reader would, with @ludion/* names pointing at their tarballs. */
function sh(code, cwd, extraEnv = {}) {
  const script = code.replace(/(^|\s)(@ludion\/[a-z-]+)(?=\s|$)/g, (_, sp, name) => `${sp}${installSet(name)}`);
  const r = spawnSync(bash(), ["-c", script], { cwd, encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 600_000, maxBuffer: 64e6 });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

/** A published name → its tarball and those of its @ludion dependencies (npm would fetch them). */
function installSet(name) {
  const dirOf = Object.fromEntries(SET.map((d) => [manifest(d).name, d]));
  const need = new Set(), visit = (n) => {
    if (need.has(n)) return;
    need.add(n);
    for (const dep of Object.keys(manifest(dirOf[n]).dependencies ?? {})) if (dirOf[dep]) visit(dep);
  };
  visit(name);
  return [...need].map((n) => `"${posix(tarballs[n])}"`).join(" ");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-web10-"));
  fs.mkdirSync(path.join(tmp, "tgz"));
  const files = packAll(path.join(tmp, "tgz"));
  tarballs = Object.fromEntries(SET.map((d, i) => [manifest(d).name, files[i]]));
  env = { ...process.env, npm_config_cache: path.join(tmp, "npm-cache"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false",
    npm_config_yes: "true", NO_COLOR: "1" };
});
after(() => {
  killTree(server);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
});

const receiptClass = (headers) => {
  const r = /^ludion-receipt: *(\S+)/im.exec(headers)?.[1];
  return r ? JSON.parse(Buffer.from(r, "base64url").toString("utf8")).class : null;
};

test("WEB-10: the quickstart runs as written: the Gate at Pressure 0 classifies, and the agent's signed request verifies", { timeout: 1_200_000 }, async () => {
  const page = blocks(fs.readFileSync(PAGE, "utf8"));
  const siteBlocks = page.filter((b) => /^For a site/.test(b.section));
  const agentBlocks = page.filter((b) => /^For an agent/.test(b.section));
  assert.ok(siteBlocks.length >= 6 && agentBlocks.length >= 3, `the page's blocks: ${page.map((b) => `${b.section}/${b.lang}`).join(", ")}`);
  assert.ok(await portFree(PORT), `port ${PORT} is taken: the page's server needs it`);

  const site = path.join(tmp, "my-shop");
  fs.mkdirSync(site);
  let checked = 0;

  // ── For a site ───────────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < siteBlocks.length; i++) {
    const b = siteBlocks[i], next = siteBlocks[i + 1];
    if (b.title) { fs.writeFileSync(path.join(site, b.title), b.code); continue; }
    if (b.lang === "text") continue; // read with the command before it
    assert.equal(b.lang, "sh", `a block to run: ${b.code}`);
    if (b.code.trim() === "node server.mjs") {
      server = spawn(process.execPath, ["server.mjs"], { cwd: site, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      server.stdout.on("data", (d) => { log += d; });
      server.stderr.on("data", (d) => { log += d; });
      const until = Date.now() + 30_000;
      while (!log.includes(`http://localhost:${PORT}`)) {
        assert.ok(server.exitCode == null, `node server.mjs exited: ${log}`);
        assert.ok(Date.now() < until, `node server.mjs said nothing in 30 s: ${log}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      continue;
    }
    const r = sh(b.code, site);
    assert.equal(r.code, 0, `\`${b.code}\` failed:\n${r.err.slice(-2000)}`);
    if (next?.lang === "text") {
      assert.ok(printsAsShown(r.out, next.code), `\`${b.code}\` printed:\n${r.out}\nThe page shows:\n${next.code}`);
      checked++;
    }
  }
  assert.ok(checked >= 2, `outputs compared with the page: ${checked}`);

  // "A browser gets UNKNOWN, and the page it gets is the same."
  const ua = (agent) => sh(`curl -s -D - -A "${agent}" http://localhost:${PORT}/`, site).out;
  const crawler = ua("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)");
  const browser = ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");
  assert.equal(receiptClass(crawler), "DECLARED");
  assert.equal(receiptClass(browser), "UNKNOWN");
  const body = (r) => r.replace(/\r\n/g, "\n").split("\n\n").slice(1).join("\n\n");
  assert.equal(body(browser), body(crawler), "the same page");

  // ── For an agent ─────────────────────────────────────────────────────────────────────────────
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(agent);
  fs.writeFileSync(path.join(agent, "package.json"), JSON.stringify({ name: "web10-agent", private: true }));
  const inst = sh(`npm install --no-package-lock ${installSet("ludion")}`, agent);
  assert.equal(inst.code, 0, `installing ludion's tarball: ${inst.err.slice(-1500)}`);

  const [init, doctor, sign] = agentBlocks;
  assert.match(init.code, /^npx ludion init /);
  const r1 = sh(init.code, agent, { LUDION_ROOT_PASSPHRASE: PASSPHRASE });
  assert.equal(r1.code, 0, `${init.code}: ${r1.err}`);
  for (const f of ["ludion.json", ".well-known/http-message-signatures-directory", "card"]) assert.ok(fs.existsSync(path.join(agent, f)), `init wrote ${f}`);
  const domain = /--domain (\S+)/.exec(init.code)[1];

  assert.equal(doctor.code.trim(), "npx ludion doctor");
  const r2 = sh(doctor.code, agent, { LUDION_ROOT_PASSPHRASE: PASSPHRASE });
  // Not yet published (agent.example.com is not ours): doctor must say so, for both files.
  assert.match(r2.out + r2.err, /http-message-signatures-directory unreachable/);
  assert.match(r2.out + r2.err, /\/card unreachable/);

  assert.match(sign.code, /^npx ludion sign GET http:\/\/localhost:3000\/ --curl$/m);
  const r3 = sh(sign.code, agent, { LUDION_ROOT_PASSPHRASE: PASSPHRASE });
  assert.equal(r3.code, 0, r3.err);
  const command = r3.out.split("\n#")[0].trim();
  assert.match(command, /^curl -X GET -H 'signature-agent: /);
  // "Run it with -sI against the site you set up above."
  const sent = sh(command.replace(/^curl /, "curl -sI "), site).out;
  assert.equal(receiptClass(sent), "UNVERIFIED", `the quickstart's Gate cannot reach https://${domain} from here:\n${sent}`);

  // The same request, at a Gate that has the directory the reader publishes.
  const { createGate, generateSiteKey } = await import(pathToFileURL(path.join(site, "node_modules", "@ludion", "gate-core", "src", "index.mjs")).href);
  const headers = [...command.matchAll(/-H '([^:]+): ((?:[^']|'\\'')*)'/g)].map((m) => ({ name: m[1], value: m[2].replace(/'\\''/g, "'") }));
  const request = (fields) => ({ kind: "request", method: "GET", targetUri: `http://localhost:${PORT}/`, fields: [{ name: "user-agent", value: "web10" }, ...fields] });
  const directory = JSON.parse(fs.readFileSync(path.join(agent, ".well-known", "http-message-signatures-directory"), "utf8"));
  const gateWith = async () => {
    const gate = await createGate({ siteId: "site-my-shop", siteKey: (await generateSiteKey()).privateJwk, pressure: 0 });
    await gate.resolver.prime({ type: "directory", uri: `https://${domain}` }, directory);
    return gate;
  };
  const ok = await (await gateWith()).inspect(request(headers));
  assert.equal(ok.cls.class, "VERIFIED", JSON.stringify(ok.cls));
  assert.equal(ok.cls.identifier, `https://${domain}`);
  const tampered = headers.map((h) => (h.name === "signature" ? { ...h, value: h.value.replace(/:(.)/, (_, c) => `:${c === "A" ? "B" : "A"}`) } : h));
  assert.notEqual((await (await gateWith()).inspect(request(tampered))).cls.class, "VERIFIED", "a tampered copy");
  const elsewhere = await (await gateWith()).inspect({ ...request(headers), targetUri: "http://localhost:3001/" });
  assert.notEqual(elsewhere.cls.class, "VERIFIED", "the same signature at another authority");

  console.log(`WEB-10: ${siteBlocks.length + agentBlocks.length} blocks run as written, ${checked} outputs equal to the page; DECLARED, UNKNOWN, then VERIFIED from the directory init wrote`);
});

test("WEB-10: the runner bites: a page whose output differs, or whose block fails, is caught", () => {
  assert.equal(printsAsShown("Ludion-Version: 0\nLudion-Receipt: eyJ2IjowLCJyaWQiOiJyY3AtXYZ\n", "Ludion-Version: 0\nLudion-Receipt: eyJ2IjowLCJyaWQiOiJyY3At…"), true);
  assert.equal(printsAsShown("Ludion-Version: 0\n", "Ludion-Version: 0\nLudion-Receipt: eyJ…"), false, "a missing line");
  assert.equal(printsAsShown("Ludion-Version: 1\nLudion-Receipt: eyJx\n", "Ludion-Version: 0\nLudion-Receipt: eyJ…"), false, "another value");
  assert.equal(printsAsShown("UNKNOWN\n", "DECLARED"), false);
  assert.equal(printsAsShown("Ludion-Receipt: \n", "Ludion-Receipt: …"), false, "… stands for something, not nothing");
  const b = blocks('## For a site: x\n\n```sh\nnpm init -y\n```\n\n```js title="server.mjs"\nconsole.log(1)\n```\n\n## For an agent: y\n\n```text\nOK\n```\n');
  assert.deepEqual(b.map((x) => [x.section, x.lang, x.title]), [["For a site: x", "sh", null], ["For a site: x", "js", "server.mjs"], ["For an agent: y", "text", null]]);
  if (process.platform === "win32") bash(); // Git's bash is found where the CI runner has it
  const fail = spawnSync(bash(), ["-c", "exit 3"], { encoding: "utf8" });
  assert.equal(fail.status, 3, "a failing block fails");
});
