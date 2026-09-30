// The site as it deploys to Workers, run locally for the site oracles (WEB-8): wrangler dev (workerd)
// with the real site/edge/wrangler.json, pointed at a built dist, and a notifier stub for the
// signup endpoint to reach. site/edge is its own npm project, installed in place from its lockfile.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { SITE, ensureDeps } from "../build.mjs";

export const EDGE = path.join(SITE, "edge");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Kill a child and everything it spawned (wrangler dev forks workerd). */
function killTree(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
}

/**
 * Start the Worker on the built site. `main` swaps the entry (the planted faults of the self-test);
 * `vars` become Worker variables, as `wrangler secret put` would give them on the preview.
 * @returns {Promise<{ origin: string, log: string, stop: () => Promise<void> }>}
 */
export async function startEdge({ dist, main = path.join(EDGE, "worker.mjs"), vars = {}, readyTimeoutMs = 90_000 }) {
  ensureDeps(EDGE);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ludion-edge-"));
  const config = JSON.parse(fs.readFileSync(path.join(EDGE, "wrangler.json"), "utf8"));
  config.main = main;
  config.assets = { ...config.assets, directory: dist };
  const file = path.join(tmp, "wrangler.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const [port, inspector] = [await freePort(), await freePort()];
  const args = [path.join(EDGE, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", "-c", file, "--port", String(port), "--ip", "127.0.0.1",
    "--inspector-port", String(inspector), "--persist-to", path.join(tmp, "state"), "--show-interactive-dev-session=false", "--log-level", "warn",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
  const child = spawn(process.execPath, args, { cwd: EDGE, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" } });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    killTree(child);
    if (child.exitCode == null && child.signalCode == null) await new Promise((r) => { const t = setTimeout(r, 5000); child.once("exit", () => { clearTimeout(t); r(); }); });
    child.stdout.destroy(); child.stderr.destroy();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const until = Date.now() + readyTimeoutMs;
  for (;;) {
    if (child.exitCode != null) { await stop(); throw new Error(`wrangler dev exited (${child.exitCode}):\n${log.slice(-2000)}`); }
    try { if ((await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) })).status === 200) break; } catch { /* not up yet */ }
    if (Date.now() > until) { await stop(); throw new Error(`wrangler dev not ready in ${readyTimeoutMs}ms:\n${log.slice(-2000)}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { origin, get log() { return log; }, stop };
}

/**
 * A notifier stub: an incoming webhook that records what it is sent and answers `status`.
 * @returns {Promise<{ url: string, received: { headers: object, body: any }[], close: () => Promise<void> }>}
 */
export async function startNotifier({ status = 200 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = Buffer.concat(chunks).toString("utf8"); }
      received.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
