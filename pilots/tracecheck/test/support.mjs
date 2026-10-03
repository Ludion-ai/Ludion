// A D1 binding on node:sqlite (the subset the pilot uses: prepare/bind/run/all, batch), and a
// Workers-shaped world around the pilot: the site behind it, agents' key directories, ctx.
import { DatabaseSync } from "node:sqlite";

export function d1({ fail = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    async run() { if (fail) throw new Error("D1_ERROR: planted"); db.prepare(sql).run(...args); return { success: true }; },
    async all() { if (fail) throw new Error("D1_ERROR: planted"); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    rows: (sql = "SELECT * FROM events ORDER BY rowid") => db.prepare(sql).all().map((r) => ({ ...r })),
  };
}

/**
 * Replace globalThis.fetch: requests to the site go to `origin(request)`, key directories are
 * answered from `directories` (URL → JWKS), anything else from `others`.
 */
export function world({ site = "https://tracecheck.dev", origin, directories = {}, others } = {}) {
  const calls = { origin: [], directory: [], other: [] };
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url.startsWith(site + "/")) { calls.origin.push(req); return origin(req); }
    if (directories[req.url]) {
      calls.directory.push(req.url);
      return new Response(JSON.stringify(directories[req.url]), { headers: { "content-type": "application/http-message-signatures-directory+json" } });
    }
    calls.other.push(req);
    if (others) return others(req);
    throw new TypeError(`unexpected fetch ${req.url}`);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

export function context() {
  const pending = [];
  return {
    pending, passedThrough: false,
    waitUntil(p) { pending.push(p); },
    passThroughOnException() { this.passedThrough = true; },
    async settle() { while (pending.length) await Promise.allSettled(pending.splice(0)); },
  };
}

export const ENV = (db, over = {}) => ({
  EVENTS: db,
  LUDION: { site_id: "tracecheck.dev", pressure: 0, authorities: ["tracecheck.dev"] },
  REPORT_TZ: "Asia/Tokyo", RETAIN_DAYS: "90",
  ...over,
});

export const quietLog = () => { const lines = []; return { lines, error: (m) => lines.push(m), log: (m) => lines.push(m) }; };
