// Which Cloudflare resources are Ludion's, for the deletion list in docs/DEPLOY.md §1.3.
// Only Ludion's may enter the list. Ludion = the name says "ludion", or it serves ludion.ai (custom
// domain, route, Pages domain), or a Ludion Worker binds it (KV, D1, R2). The new preview is kept.
// Everything else (another product's, e.g. synteria) is listed apart and never enters the list,
// whatever its name. `node scripts/cf-classify.mjs --self-test` checks these rules.

export const KEEP = new Set(["ludion-site-preview"]);
const OTHER_PRODUCT = /synteria/i; // never Ludion's, whatever else matches
const LUDION_NAME = /ludion/i;

/** @returns {{ ludion: object[], other: object[] }} rows {kind, name, why, created, last, domains, keep} */
export function classify({ scripts, domains, routes, pages, kv, d1, r2, zoneName = "ludion.ai" }) {
  const onZone = (h) => h === zoneName || String(h).endsWith(`.${zoneName}`) || String(h).includes(`${zoneName}/`);
  const res = (x) => (Array.isArray(x?.result) ? x.result : x?.result?.buckets ?? []);
  const out = { ludion: [], other: [] };
  const put = (row, isLudion, why) => {
    if (OTHER_PRODUCT.test(row.name)) return out.other.push({ ...row, why: "another product (by name)" });
    (isLudion ? out.ludion : out.other).push({ ...row, why, keep: KEEP.has(row.name) });
  };
  const why = (byName, byZone) => (byName ? "name" : byZone ? `serves ${zoneName}` : "not Ludion's");
  const boundTo = (name) => [...res(domains).filter((d) => d.service === name).map((d) => d.hostname),
    ...res(routes).filter((r) => r.script === name).map((r) => r.pattern)];

  const ludionWorkers = new Set();
  for (const w of res(scripts)) {
    const doms = boundTo(w.id), byName = LUDION_NAME.test(w.id), byZone = doms.some(onZone);
    if ((byName || byZone) && !OTHER_PRODUCT.test(w.id)) ludionWorkers.add(w.id);
    put({ kind: "Worker", name: w.id, created: w.created_on, last: w.modified_on, domains: doms }, byName || byZone, why(byName, byZone));
  }
  for (const p of res(pages)) {
    const doms = p.domains ?? [], byName = LUDION_NAME.test(p.name), byZone = doms.some(onZone);
    put({ kind: "Pages", name: p.name, created: p.created_on, last: p.latest_deployment?.created_on, domains: doms }, byName || byZone, why(byName, byZone));
  }
  const boundBy = (type, id) => res(scripts).filter((w) => ludionWorkers.has(w.id) &&
    (w.bindings ?? []).some((b) => b.type === type && (b.namespace_id === id || b.id === id || b.bucket_name === id))).map((w) => w.id);
  const store = (kind, type, name, id, created) => {
    const by = boundBy(type, id), byName = LUDION_NAME.test(name);
    put({ kind, name, id, created }, byName || by.length > 0, byName ? "name" : by.length ? `bound by ${by.join(", ")}` : "not Ludion's");
  };
  for (const n of res(kv)) store("KV", "kv_namespace", n.title, n.id);
  for (const d of res(d1)) store("D1", "d1", d.name, d.uuid, d.created_at);
  for (const b of res(r2)) store("R2", "r2_bucket", b.name, b.name, b.creation_date);
  // The bucket list may be unreadable (no R2 permission). A bucket a Ludion Worker binds is still Ludion's.
  if (r2?.error) {
    const seen = new Set();
    for (const w of res(scripts)) {
      if (!ludionWorkers.has(w.id)) continue;
      for (const b of w.bindings ?? []) {
        if (b.type !== "r2_bucket" || seen.has(b.bucket_name ?? b.name)) continue;
        seen.add(b.bucket_name ?? b.name);
        put({ kind: "R2", name: b.bucket_name ?? b.name }, true, `bound by ${w.id} (bucket list not readable: check in the dashboard)`);
      }
    }
  }
  return out;
}

const day = (s) => (s ? String(s).slice(0, 10) : "?");
/** Markdown for DEPLOY.md §1.3: Ludion's (deletion candidates, the preview kept) and the others apart. */
export function classifiedTables(x) {
  const { ludion, other } = classify(x);
  return ["## Ludion の資源（削除リストの候補。新しいプレビューは残す）", "",
    "| 種類 | 名前 | 判定の理由 | 作成日 | 最後の更新 | 結びついたドメイン | 扱い |", "|---|---|---|---|---|---|---|",
    ...(ludion.length ? ludion.map((r) => `| ${r.kind} | ${r.name} | ${r.why} | ${day(r.created)} | ${day(r.last)} | ${(r.domains ?? []).join(", ") || "-"} | ${r.keep ? "残す（新）" : "削除の候補"} |`) : ["| （なし） | | | | | | |"]), "",
    "## 対象外（Ludion のものではない。削除リストに入れない）", "",
    "| 種類 | 名前 | 理由 |", "|---|---|---|", ...(other.length ? other.map((r) => `| ${r.kind} | ${r.name} | ${r.why} |`) : ["| （なし） | | |"]), ""];
}

if (process.argv.includes("--self-test")) {
  const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok", m); };
  const c = classify({
    scripts: { result: [{ id: "ludion-old", bindings: [{ type: "kv_namespace", name: "K", namespace_id: "kv1" }] }, { id: "shop-edge" },
      { id: "synteria-ludion-bridge" }, { id: "ludion-site-preview" }, { id: "landing" }] },
    domains: { result: [{ hostname: "ludion.ai", service: "landing" }, { hostname: "synteria.com", service: "shop-edge" }] }, routes: { result: [] },
    pages: { result: [{ name: "ludion-web", domains: ["ludion-web.pages.dev"] }, { name: "synteria-site", domains: ["synteria.com"] }, { name: "blog", domains: ["www.ludion.ai"] }] },
    kv: { result: [{ id: "kv1", title: "sessions" }, { id: "kv2", title: "synteria-cache" }] }, d1: { result: [{ uuid: "d1", name: "synteria-db" }] }, r2: { result: [] },
  });
  const L = c.ludion.map((r) => r.name).sort(), O = c.other.map((r) => r.name).sort();
  ok(JSON.stringify(L) === JSON.stringify(["blog", "landing", "ludion-old", "ludion-site-preview", "ludion-web", "sessions"]), `Ludion's by name, by ludion.ai, by a Ludion Worker's binding: ${L}`);
  ok(["synteria-ludion-bridge", "synteria-site", "shop-edge", "synteria-cache", "synteria-db"].every((n) => O.includes(n)), `others never enter the list, even with "ludion" in the name: ${O}`);
  ok(c.ludion.find((r) => r.name === "ludion-site-preview").keep === true, "the new preview is kept");
  const r2 = classify({ scripts: { result: [{ id: "ludion-x", bindings: [{ type: "r2_bucket", name: "B", bucket_name: "uploads" }] }, { id: "other", bindings: [{ type: "r2_bucket", bucket_name: "theirs" }] }] },
    domains: { result: [] }, routes: { result: [] }, pages: { result: [] }, kv: { result: [] }, d1: { result: [] }, r2: { error: "403" } });
  ok(r2.ludion.some((r) => r.kind === "R2" && r.name === "uploads") && !r2.ludion.some((r) => r.name === "theirs"), "an unreadable bucket list still yields the buckets Ludion Workers bind, and only those");
}
