// The pilot as it deploys (the real wrangler.jsonc and bundle), in workerd via `wrangler dev`,
// in front of a stub of the site (--local-upstream) and with the report webhook stubbed. Used by
// the PILOT-1 oracle; slow (it installs wrangler from this folder's lockfile and starts workerd).
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDeps } from "../../../site/build.mjs";

export const PILOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(PILOT, "node_modules", "wrangler", "bin", "wrangler.js");

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function killTree(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
}

/** An HTTP server that records what reaches it and answers with `respond(req, body)`. */
export async function stubServer(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      const { status = 200, headers = {}, body: out = "" } = respond(req, body);
      res.writeHead(status, headers);
      res.end(out);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const run = (args, opts = {}) => execFileSync(process.execPath, [WRANGLER, ...args], {
  cwd: PILOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" }, ...opts,
});

/**
 * Start the pilot in workerd in front of `upstreamPort`.
 * @returns {Promise<{ origin: string, log: string, d1: (sql: string) => object[], stop: () => Promise<void> }>}
 */
export async function startPilot({ upstreamPort, vars = {}, readyTimeoutMs = 90_000 }) {
  ensureDeps(PILOT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-pilot-"));
  const state = path.join(tmp, "state");
  const [port, inspector] = [await freePort(), await freePort()];
  const args = [WRANGLER, "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector),
    "--local-upstream", `127.0.0.1:${upstreamPort}`, "--upstream-protocol", "http", "--test-scheduled",
    "--persist-to", state, "--show-interactive-dev-session=false", "--log-level", "info",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
  const child = spawn(process.execPath, args, { cwd: PILOT, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" } });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const origin = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    killTree(child);
    if (child.exitCode == null && child.signalCode == null) await new Promise((r) => { const t = setTimeout(r, 5000); child.once("exit", () => { clearTimeout(t); r(); }); });
    child.stdout.destroy(); child.stderr.destroy();
  };
  const until = Date.now() + readyTimeoutMs;
  for (;;) {
    if (child.exitCode != null) { await stop(); throw new Error(`wrangler dev exited (${child.exitCode}):\n${log.slice(-2000)}`); }
    if (/Ready on/i.test(log)) break;
    if (Date.now() > until) { await stop(); throw new Error(`wrangler dev not ready in ${readyTimeoutMs}ms:\n${log.slice(-2000)}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    origin, get log() { return log; }, stop,
    /** Query the local D1 (after stop()). */
    d1(sql) {
      const out = run(["d1", "execute", "ludion-tracecheck", "--local", "--persist-to", state, "--json", "--command", sql]);
      return JSON.parse(out)[0].results;
    },
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); },
  };
}
