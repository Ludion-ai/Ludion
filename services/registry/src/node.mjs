// Node adapters for the Registry: an http listener that streams responses (the revocation stream
// must not be buffered) and a JSON file store.
import fs from "node:fs";
import path from "node:path";
import { createMemoryStore } from "./index.mjs";

const MAX_BODY = 16 * 1024;

/**
 * `http.createServer(nodeListener(registry, { scheme }))`. `scheme` is what the Registry is reached
 * with behind TLS termination (default https); the Host header gives the authority.
 */
export function nodeListener(registry, { scheme = "https" } = {}) {
  return async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"too_large"}'); return; }
        chunks.push(c);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      const r = await registry.fetch(new Request(`${scheme}://${req.headers.host ?? "invalid"}${req.url}`, {
        method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined, signal: ac.signal,
      }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body || req.method === "HEAD") { res.end(); return; }
      const reader = r.body.getReader();
      ac.signal.addEventListener("abort", () => reader.cancel().catch(() => {}));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
      }
      res.end();
    } catch {
      if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); }
      else res.destroy();
    }
  };
}

/** A store kept in one JSON file: loaded at start, rewritten atomically after every change. */
export function createFileStore(file) {
  let state;
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return createMemoryStore({
    state,
    save: (s) => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  });
}
