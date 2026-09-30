// STD-4: the drafts Ludion implements, against the IETF datatracker and against the repository.
//
//   datatracker  each pinned draft is the latest revision of the latest document. When a newer
//                revision (or a replacing draft) appears, there are `graceDays` to follow it; the
//                result carries the issue to open (what changed, the diff, the deadline) and
//                passes. After that it fails. A pin ahead of the datatracker fails. A datatracker
//                that cannot be read fails: an unknown is never a pass.
//   repository   every `draft-…-NN` reference to a Web Bot Auth draft in the code, the spec and
//                MISSION.md names a pinned draft at its pinned revision. ADRs, STATE.md and the
//                outbox are records of their day and are not read; neither is accept/std4/ itself,
//                whose tests are made of drafts that must not match.
//
// Pure logic: fetch and the clock are passed in (accept/std4/drafts.test.mjs runs it offline).

export const TRACKER = "https://datatracker.ietf.org";
const DAY_MS = 86_400_000;
const MAX_HOPS = 5;

/** A draft family Ludion cares about: every Web Bot Auth draft, whoever writes it. */
export const WEB_BOT_AUTH = /^draft-[a-z0-9-]*(webbotauth|web-bot-auth)[a-z0-9-]*$/;

/** GET a datatracker JSON document, with retries and a timeout per attempt. */
export async function getJson(url, { fetch, attempts = 3, timeoutMs = 15_000, backoffMs = 1000 }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, backoffMs * 3 ** (i - 1)));
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (res.status === 404) return null;
      if (res.status !== 200) { last = new Error(`${url}: HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (e) { last = new Error(`${url}: ${e?.message ?? e}`); }
  }
  throw last;
}

const revNum = (r) => (/^\d{2}$/.test(String(r)) ? Number(r) : NaN);

/**
 * What the datatracker says about a pinned draft: the document now in force (following
 * "Replaced" to its successor) and when the first thing newer than the pin was published.
 * @returns {Promise<{ pin: {name,rev}, latest: {name, rev, pages, state}, newer: null | { name, rev, published, pages, via: "revision"|"replaced" }, hops: string[] }>}
 */
export async function track(pin, { fetch, attempts, backoffMs }) {
  const get = (u) => getJson(u, { fetch, attempts, backoffMs });
  const doc = await get(`${TRACKER}/doc/${pin.name}/doc.json`);
  if (!doc || doc.name !== pin.name || !/^\d{2}$/.test(doc.rev ?? "")) throw new Error(`${pin.name}: the datatracker does not know this draft`);
  const hops = [pin.name];
  let newer = null, cur = doc;
  const pinned = revNum(pin.rev);
  if (revNum(doc.rev) < pinned) throw new Error(`${pin.name}: pinned -${pin.rev} is ahead of the datatracker's -${doc.rev}`);
  if (revNum(doc.rev) > pinned) {
    const first = (doc.rev_history ?? []).filter((h) => h.name === pin.name && revNum(h.rev) > pinned).sort((a, b) => revNum(a.rev) - revNum(b.rev))[0];
    newer = { name: pin.name, rev: first?.rev ?? doc.rev, published: first?.published ?? doc.time, pages: first?.pages ?? doc.pages, via: "revision" };
  }
  while (cur.state === "Replaced") {
    if (hops.length > MAX_HOPS) throw new Error(`${pin.name}: more than ${MAX_HOPS} replacements`);
    const rel = await get(`${TRACKER}/api/v1/doc/relateddocument/?relationship__slug=replaces&target__name=${encodeURIComponent(cur.name)}&format=json`);
    const source = rel?.objects?.[0]?.source;
    const name = typeof source === "string" ? /\/doc\/document\/([^/]+)\/?$/.exec(source)?.[1] : undefined;
    if (!name) throw new Error(`${cur.name}: marked Replaced, but the datatracker names no successor`);
    const next = await get(`${TRACKER}/doc/${name}/doc.json`);
    if (!next || !/^\d{2}$/.test(next.rev ?? "")) throw new Error(`${name}: the successor of ${cur.name} is not readable`);
    hops.push(name);
    const firstRev = (next.rev_history ?? []).filter((h) => h.name === name).sort((a, b) => revNum(a.rev) - revNum(b.rev))[0];
    const when = firstRev?.published ?? next.time;
    // The clock starts at the first thing newer than the pin: the replacement, unless a newer
    // revision of the pinned draft came before it.
    if (!newer || Date.parse(when) < Date.parse(newer.published)) newer = { name, rev: firstRev?.rev ?? next.rev, published: when, pages: firstRev?.pages ?? next.pages, via: "replaced" };
    cur = next;
  }
  return { pin, latest: { name: cur.name, rev: cur.rev, pages: cur.pages, state: cur.state }, newer, hops };
}

/** The issue to open for a draft that moved: what changed, where to read the diff, the deadline. */
export function issueFor(t, { graceDays, now }) {
  const from = `${t.pin.name}-${t.pin.rev}`, to = `${t.latest.name}-${t.latest.rev}`;
  const due = new Date(Date.parse(t.newer.published) + graceDays * DAY_MS);
  const days = Math.floor((now - Date.parse(t.newer.published)) / DAY_MS);
  return {
    title: `STD-4: follow ${to} (pinned ${from})`,
    due,
    body: [
      `The datatracker has moved past ${from}.`,
      t.newer.via === "replaced" ? `- ${t.hops.join(" → ")}: replaced; now ${to}.` : `- ${t.pin.name}: -${t.pin.rev} → -${t.latest.rev}.`,
      `- First newer: ${t.newer.name}-${t.newer.rev}, published ${t.newer.published} (${days} days ago)${t.newer.pages ? `, ${t.newer.pages} pages` : ""}.`,
      `- Diff: https://author-tools.ietf.org/iddiff?url1=${from}&url2=${to}`,
      `- Follow by ${due.toISOString().slice(0, 10)}: update the code, the spec and the tests, then accept/std4/pins.json. STD-4 fails after that date.`,
    ].join("\n"),
  };
}

/**
 * References in the repository: `files` is [{ path, text }] (repository-relative, "/" separated).
 * @returns {{ refs: number, problems: string[] }}
 */
export function repoRefs(files, pins) {
  const pinned = new Map(pins.map((p) => [p.name, p.rev]));
  const problems = [];
  let refs = 0;
  for (const f of files) {
    if (/^(docs\/adr\/|docs\/outbox\/|docs\/STATE\.md$|accept\/std4\/)/.test(f.path)) continue;
    for (const [token] of f.text.matchAll(/\bdraft(?:-[a-z0-9]+)+/g)) {
      const m = /^(.*)-(\d{2})$/.exec(token); // a reference to a revision ends in -NN
      if (!m || !WEB_BOT_AUTH.test(m[1])) continue;
      const [, name, rev] = m;
      refs++;
      if (!pinned.has(name)) problems.push(`${f.path}: ${token} is a Web Bot Auth draft that is not pinned`);
      else if (pinned.get(name) !== rev) problems.push(`${f.path}: ${token}, but the pin is -${pinned.get(name)}`);
    }
  }
  return { refs, problems };
}

/**
 * The whole oracle.
 * @param {{ pins: { graceDays: number, drafts: {name: string, rev: string}[] }, files: {path: string, text: string}[],
 *           fetch: typeof fetch, now: number, attempts?: number, backoffMs?: number }} o
 * @returns {Promise<{ pass: boolean, lines: string[], issues: object[], metric: string, detail?: string }>}
 */
export async function check(o) {
  const graceDays = o.pins.graceDays ?? 7;
  const lines = [], issues = [], failures = [];
  if (!o.pins.drafts?.length) failures.push("no drafts are pinned");
  for (const pin of o.pins.drafts ?? []) {
    let t;
    try { t = await track(pin, o); }
    catch (e) { failures.push(String(e?.message ?? e)); lines.push(`not ok ${pin.name}-${pin.rev}: ${e?.message ?? e}`); continue; }
    if (!t.newer) { lines.push(`ok ${pin.name}-${pin.rev} is the latest (${t.latest.state ?? "?"})`); continue; }
    const issue = issueFor(t, { graceDays, now: o.now });
    issues.push(issue);
    if (o.now > issue.due.getTime()) {
      failures.push(`${pin.name}-${pin.rev}: ${t.latest.name}-${t.latest.rev} has been out for more than ${graceDays} days`);
      lines.push(`not ok ${issue.title} — overdue since ${issue.due.toISOString().slice(0, 10)}`);
    } else lines.push(`ok ${pin.name}-${pin.rev} is behind ${t.latest.name}-${t.latest.rev}; follow by ${issue.due.toISOString().slice(0, 10)} (issue below)`);
  }
  const r = repoRefs(o.files, o.pins.drafts ?? []);
  failures.push(...r.problems);
  lines.push(r.problems.length ? `not ok ${r.problems.length} repository references disagree with the pins` : `ok ${r.refs} repository references name the pinned revisions`);
  const behind = issues.length;
  const metric = `${(o.pins.drafts ?? []).map((p) => `${p.name.replace(/^draft-/, "")} -${p.rev}`).join(", ")}; ${behind ? `${behind} behind (within ${graceDays} days)` : "all latest"}; ${r.refs} references agree`;
  return { pass: failures.length === 0, lines, issues, metric, detail: failures.length ? failures.join("; ").slice(0, 300) : undefined };
}
