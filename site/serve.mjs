#!/usr/bin/env node
// Serve a built site the way static hosts do (Cloudflare Pages, Vercel cleanUrls, nginx try_files):
// /e/x → e/x.html, /ja → ja.html, /dir/ → dir/index.html, anything else → 404.html with status 404.
//   node site/serve.mjs [dist] [--port 4321]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
  ".pf_meta": "application/octet-stream", ".pf_fragment": "application/octet-stream", ".pf_index": "application/octet-stream", ".pagefind": "application/octet-stream" };

/** The file a request path resolves to, or null. Never leaves `root`. */
export function resolveFile(root, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]); } catch { return null; }
  if (p.includes("\0")) return null;
  const abs = path.resolve(root, `.${p}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const tries = p.endsWith("/") ? [path.join(abs, "index.html")] : [abs, `${abs}.html`, path.join(abs, "index.html")];
  return tries.find(isFile) ?? null;
}

/** Start a server on 127.0.0.1; resolves to { url, close }. */
export function serve(root, { port = 0 } = {}) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    const file = resolveFile(root, req.url ?? "/");
    const status = file ? 200 : 404;
    const body = file ?? path.join(root, "404.html");
    res.writeHead(status, { "content-type": TYPES[path.extname(body)] ?? "application/octet-stream" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(body).on("error", () => res.end()).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : 4321;
  const dir = args.find((a, j) => !a.startsWith("--") && args[j - 1] !== "--port") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
  serve(dir, { port }).then(({ url }) => console.log(`serving ${dir} at ${url}`));
}
