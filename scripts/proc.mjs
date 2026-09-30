// Child processes for oracles: asynchronous (so oracles can run concurrently), tracked per oracle
// (so the scoreboard can kill what an oracle started when its cap expires), and killed as a whole
// process tree on timeout (test runners start servers, npm, next, workerd…).
import { spawn, execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

/** The children the running oracle started: the scoreboard kills them on its own timeout. */
export const oracleScope = new AsyncLocalStorage();

/** The last n non-empty lines of some output, for a timeout's detail. */
export const lastLines = (text, n = 3) => String(text ?? "").split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(" | ").slice(-240);

/** Kill a child and everything it started. */
export function killTree(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
}

/**
 * Run a child. On exit 0 `out` is stdout, otherwise stdout + stderr (as execFileSync reported it).
 * On timeout the whole tree is killed and `timedOut` is set.
 */
export function run(file, args, { cwd, timeout = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const out = [], err = [];
    let size = 0, timedOut = false;
    const keep = (buf) => (d) => { if (size < 64e6) { buf.push(d); size += d.length; } };
    child.stdout.on("data", keep(out));
    child.stderr.on("data", keep(err));
    const scope = oracleScope.getStore(), rec = { child, output: () => Buffer.concat([...out, ...err]).toString("utf8") };
    scope?.add(rec);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    child.on("error", (e) => { clearTimeout(timer); scope?.delete(rec); resolve({ code: 1, out: String(e.message) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      scope?.delete(rec);
      const so = Buffer.concat(out).toString("utf8"), se = Buffer.concat(err).toString("utf8");
      if (timedOut) resolve({ code: 124, out: so + se, timedOut: true, timeoutMs: timeout });
      else resolve(code === 0 ? { code: 0, out: so } : { code: code ?? 1, out: `${so}${se}` || "exited without output" });
    });
  });
}

export const timeoutDetail = (ms, output) => `timeout after ${Math.round(ms / 1000)}s (process tree killed); last output: ${lastLines(output) || "(none)"}`;
