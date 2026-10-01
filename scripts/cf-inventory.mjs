#!/usr/bin/env node
// Read-only inventory of a Cloudflare account, for the deletion list in docs/DEPLOY.md.
// Only GET requests. It never creates, changes or deletes anything.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/cf-inventory.mjs [--zone ludion.ai]
//
// The token needs read permissions only: Account → Workers Scripts, Cloudflare Pages,
// Workers KV Storage, D1, Workers R2 Storage (Read); Zone (ludion.ai) → Workers Routes, DNS (Read).
// A section the token cannot read is printed as such, not skipped silently.
import { classifiedTables } from "./cf-classify.mjs";
import { loadCloudflareEnv } from "./cf-env.mjs";
if (!process.argv.includes("--self-test")) console.error(`credentials: ${loadCloudflareEnv()}`);
const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
const zi = process.argv.indexOf("--zone");
const zoneName = zi > 0 ? process.argv[zi + 1] : "ludion.ai";
if (!token || !account) { console.error("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"); process.exit(2); }

async function get(p, { perPage = 50 } = {}) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4${p}${p.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`, { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!j.success) return { error: `${r.status} ${(j.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ")}` };
    if (!Array.isArray(j.result)) return { result: j.result };
    out.push(...j.result);
    const info = j.result_info;
    if (!info || j.result.length === 0 || (info.total_pages ? page >= info.total_pages : j.result.length < perPage)) break;
  }
  return { result: out };
}

const day = (s) => (s ? String(s).slice(0, 10) : "?");
const row = (...c) => `| ${c.map((x) => String(x ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
const A = `/accounts/${account}`;

const zones = await get(`/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zones.result?.[0];
const [scripts, domains, pages, kv, d1, r2, routes, dns] = await Promise.all([
  get(`${A}/workers/scripts`), get(`${A}/workers/domains`), get(`${A}/pages/projects`, { perPage: 10 }),
  get(`${A}/storage/kv/namespaces`), get(`${A}/d1/database`), get(`${A}/r2/buckets`),
  zone ? get(`/zones/${zone.id}/workers/routes`) : Promise.resolve({ error: zones.error ?? `zone ${zoneName} not visible` }),
  zone ? get(`/zones/${zone.id}/dns_records`) : Promise.resolve({ error: zones.error ?? `zone ${zoneName} not visible` }),
]);

// The script list carries no bindings; each script's settings do (GET only).
for (const s of scripts.result ?? []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${A}/workers/scripts/${encodeURIComponent(s.id)}/settings`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json()).catch(() => ({}));
  if (r.success) s.bindings = r.result?.bindings ?? [];
}

const lines = [`# Cloudflare inventory (${new Date().toISOString()}, read-only)`, ""];
const section = (title, res, head, rows) => {
  lines.push(`## ${title}`, "");
  if (res.error) { lines.push(`not readable with this token: ${res.error}`, ""); return; }
  const list = Array.isArray(res.result) ? res.result : res.result?.buckets ?? [];
  if (!list.length) { lines.push("(none)", ""); return; }
  lines.push(row(...head), row(...head.map(() => "---")), ...list.map((x) => row(...rows(x))), "");
};

const bound = (name) => [
  ...(domains.result ?? []).filter((d) => d.service === name).map((d) => d.hostname),
  ...(routes.result ?? []).filter((r) => r.script === name).map((r) => r.pattern),
].join(", ");

section("Workers", scripts, ["name", "created", "modified", "bound to (custom domains, routes)", "bindings"],
  (s) => [s.id, day(s.created_on), day(s.modified_on), bound(s.id) || "-", (s.bindings ?? []).map((b) => `${b.type}:${b.name}`).join(", ") || "?"]);
section("Workers custom domains", domains, ["hostname", "worker", "environment"], (d) => [d.hostname, d.service, d.environment]);
section(`Workers routes on ${zoneName}`, routes, ["pattern", "worker"], (r) => [r.pattern, r.script ?? "(none)"]);
section("Pages projects", pages, ["name", "created", "last deployment", "domains", "production branch"],
  (p) => [p.name, day(p.created_on), day(p.latest_deployment?.created_on), (p.domains ?? []).join(", "), p.production_branch]);
section("KV namespaces", kv, ["title", "id"], (n) => [n.title, n.id]);
section("D1 databases", d1, ["name", "created", "size (bytes)", "tables"], (d) => [d.name, day(d.created_at), d.file_size, d.num_tables]);
section("R2 buckets", r2, ["name", "created"], (b) => [b.name, day(b.creation_date)]);
section(`DNS records on ${zoneName}`, dns, ["type", "name", "content", "proxied"], (r) => [r.type, r.name, r.content, r.proxied]);
// Only Ludion's resources may become deletion candidates; the others are listed apart (cf-classify.mjs).
lines.push(...classifiedTables({ scripts, domains, routes, pages, kv, d1, r2, zoneName }));

console.log(lines.join("\n"));
