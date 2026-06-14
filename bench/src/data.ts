/**
 * Gate 4-B — the public data dashboard (`/data`), visual upgrade.
 *
 * Reads the precomputed, privacy-preserving /v1/aggregate rollup (no schema change)
 * and renders four panels as hand-rolled CSS/SVG marks — no chart library:
 *   A  device-class reality   (per-class completed-local vs server/failed bars)
 *   B  routing decisions       (R1–R6 share, neutral bars + glosses)
 *   C  speed distribution      (per-class median decode, k-anon "n<3, hidden")
 *   D  failure modes           (completed/tab-death/init-fail/other donut)
 *
 * Base stays Gate 2.6 monochrome; meaning-color lives ONLY in the marks. Every panel
 * renders cleanly at empty / sparse / full. Endpoint unreachable → framing + an honest
 * "temporarily unavailable" line, never a broken page.
 */
import "./data.css";
import { collectorUrl } from "./submit";

interface ClassRollup {
  count: number;
  local_eligible: number;
  completed: number;
  median_decode_tps: number | null;
  median_prefill_tps: number | null;
}
interface Aggregate {
  schema: string;
  updated_at: string | null;
  total_submissions: number;
  by_device_class: Record<string, ClassRollup>;
  by_rule: Record<string, number>;
  failure_modes: { completed: number; tab_death: number; init_fail: number; other: number };
}

/** The four hero classes are always shown (the invitation); `other` only when seen. */
const NAMED_CLASSES = ["desktop", "android-chromium", "ios-webkit", "webview-iab"] as const;
const CLASS_LABEL: Record<string, string> = {
  desktop: "Desktop",
  "android-chromium": "Android",
  "ios-webkit": "iOS",
  "webview-iab": "In-app browser",
  other: "Other",
};

const RULE_ORDER = ["R1", "R2", "R3", "R4", "R5", "R6"] as const;
const RULE_LABEL: Record<string, string> = {
  R1: "R1 · in-app browser",
  R2: "R2 · no WebGPU",
  R3: "R3 · iOS",
  R4: "R4 · desktop WebGPU",
  R5: "R5 · Android WebGPU",
  R6: "R6 · default",
};
const RULE_GLOSS: Record<string, string> = {
  R1: "in-app browser → server",
  R2: "no WebGPU → server",
  R3: "iOS → server",
  R4: "desktop, fits locally → local",
  R5: "Android, short prompt → local",
  R6: "default → server",
};

const FAILURE_MODES = [
  { key: "completed", label: "Completed locally", color: "var(--mark-green)" },
  { key: "tab_death", label: "Tab death (OOM / kill)", color: "var(--mark-red)" },
  { key: "init_fail", label: "Init failure", color: "var(--mark-orange)" },
  { key: "other", label: "Other", color: "var(--mark-grey)" },
] as const;

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : (n / d) * 100;
}

function pctLabel(n: number, d: number): string {
  return d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
}

function rollup(agg: Aggregate, key: string): ClassRollup {
  return (
    agg.by_device_class[key] ?? {
      count: 0,
      local_eligible: 0,
      completed: 0,
      median_decode_tps: null,
      median_prefill_tps: null,
    }
  );
}

/** Classes to render: the four named ones, plus `other` only if it has volume. */
function classKeys(agg: Aggregate): string[] {
  const keys: string[] = [...NAMED_CLASSES];
  if (rollup(agg, "other").count > 0) keys.push("other");
  return keys;
}

/** Duration since an ISO instant, in words. Timezone-safe: a delta of epoch ms (OQ2). */
function relativeTime(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = Math.max(0, Date.now() - t);
  const s = ms / 1000;
  if (s < 45) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.max(1, Math.round(m))} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// --- header / stat row ---------------------------------------------------------

function renderStats(agg: Aggregate): void {
  $("stat-total").textContent = `${agg.total_submissions}`;
  const seen = classKeys(agg).filter((k) => rollup(agg, k).count > 0).length;
  $("stat-classes").textContent = `${seen}`;
  const rel = agg.updated_at === null ? null : relativeTime(agg.updated_at);
  $("stat-updated").textContent = rel === null ? "not yet computed" : `updated ${rel}`;
}

// --- Panel A: device-class reality --------------------------------------------

function renderPanelA(agg: Aggregate): void {
  const root = $("a-bars");
  root.replaceChildren();
  for (const key of classKeys(agg)) {
    const r = rollup(agg, key);
    const row = el("div", "arow");
    row.appendChild(el("span", "name", CLASS_LABEL[key] ?? key));

    const track = el("div", "atrack");
    if (r.count === 0) {
      track.appendChild(el("span", "await", "awaiting data"));
    } else {
      const local = el("span", "seg local");
      local.style.width = `${pct(r.completed, r.count)}%`;
      const server = el("span", "seg server");
      server.style.width = `${100 - pct(r.completed, r.count)}%`;
      track.append(local, server);
    }
    row.appendChild(track);
    row.appendChild(el("span", "n", r.count === 0 ? "" : `n=${r.count}`));
    root.appendChild(row);
  }
  $("a-takeaway").textContent = takeaway(agg);
}

/** Pick the sharpest completed-local contrast present, stated plainly. */
function takeaway(agg: Aggregate): string {
  const seen = classKeys(agg)
    .map((k) => ({ k, r: rollup(agg, k) }))
    .filter((x) => x.r.count > 0)
    .map((x) => ({ label: CLASS_LABEL[x.k] ?? x.k, p: Math.round(pct(x.r.completed, x.r.count)) }));
  const first = seen[0];
  if (first === undefined) {
    return "Awaiting the first submissions — your device could be the first bar above.";
  }
  let lo = first;
  let hi = first;
  for (const x of seen) {
    if (x.p < lo.p) lo = x;
    if (x.p > hi.p) hi = x;
  }
  if (seen.length === 1) return `${hi.label}: ${hi.p}% completed a local run.`;
  if (lo.p === hi.p) return `Every class so far: ${hi.p}% completed a local run.`;
  return `${lo.label}: ${lo.p}% completed a local run · ${hi.label}: ${hi.p}%.`;
}

// --- Panels B & C: labelled track bars ----------------------------------------

function bRow(label: string, gloss: string, frac: number, valText: string): HTMLElement {
  const row = el("div", "rrow");
  const head = el("div", "rhead");
  head.appendChild(el("span", "rlabel", label));
  head.appendChild(el("span", "rval", valText));
  row.appendChild(head);
  const track = el("div", "rtrack");
  const bar = el("span", "bar neutral");
  bar.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
  track.appendChild(bar);
  row.appendChild(track);
  row.appendChild(el("div", "gloss", gloss));
  return row;
}

function renderPanelB(agg: Aggregate): void {
  const root = $("b-bars");
  root.replaceChildren();
  const total = agg.total_submissions;
  for (const id of RULE_ORDER) {
    const n = agg.by_rule[id] ?? 0;
    const val = total === 0 ? "—" : `${n} · ${pctLabel(n, total)}`;
    root.appendChild(bRow(RULE_LABEL[id] ?? id, RULE_GLOSS[id] ?? "", pct(n, total) / 100, val));
  }
}

function renderPanelC(agg: Aggregate): void {
  const root = $("c-bars");
  root.replaceChildren();
  const shown = classKeys(agg);
  const medians = shown
    .map((k) => rollup(agg, k).median_decode_tps)
    .filter((v): v is number => v !== null);
  const max = medians.length > 0 ? Math.max(...medians) : 0;

  for (const key of shown) {
    const r = rollup(agg, key);
    const row = el("div", "rrow");
    const head = el("div", "rhead");
    head.appendChild(el("span", "rlabel", CLASS_LABEL[key] ?? key));
    if (r.median_decode_tps === null) {
      head.appendChild(el("span", "rval", ""));
      row.appendChild(head);
      const pillWrap = el("div");
      pillWrap.appendChild(el("span", "hidden-pill", "n<3, hidden"));
      row.appendChild(pillWrap);
    } else {
      head.appendChild(el("span", "rval", `${r.median_decode_tps} tok/s`));
      row.appendChild(head);
      const track = el("div", "rtrack");
      const bar = el("span", "bar speed");
      bar.style.width = `${max === 0 ? 0 : Math.max(6, (r.median_decode_tps / max) * 100)}%`;
      track.appendChild(bar);
      row.appendChild(track);
    }
    root.appendChild(row);
  }
}

// --- Panel D: hand-rolled SVG donut (OQ1) -------------------------------------

function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function renderPanelD(agg: Aggregate): void {
  const root = $("d-donut");
  root.replaceChildren();
  const total = agg.total_submissions;

  const title = svg("title");
  title.id = "d-donut-title";
  title.textContent = `Failure modes over ${total} submissions`;
  root.appendChild(title);

  // Background track ring (always present — the empty-state grey ring).
  const track = svg("circle");
  track.setAttribute("class", "ring track-ring");
  track.setAttribute("cx", "21");
  track.setAttribute("cy", "21");
  track.setAttribute("r", "15.91549431");
  root.appendChild(track);

  // Colored arcs. r chosen so circumference = 100 → dasharray reads as percent.
  let acc = 0;
  if (total > 0) {
    for (const mode of FAILURE_MODES) {
      const n = agg.failure_modes[mode.key];
      if (n <= 0) continue;
      const p = (n / total) * 100;
      const arc = svg("circle");
      arc.setAttribute("class", "ring");
      arc.setAttribute("cx", "21");
      arc.setAttribute("cy", "21");
      arc.setAttribute("r", "15.91549431");
      arc.style.stroke = mode.color;
      arc.setAttribute("stroke-dasharray", `${p} ${100 - p}`);
      arc.setAttribute("stroke-dashoffset", `${125 - acc}`);
      root.appendChild(arc);
      acc += p;
    }
  }

  const center = svg("text");
  center.setAttribute("class", total === 0 ? "donut-center empty" : "donut-center");
  center.setAttribute("x", "21");
  center.setAttribute("y", total === 0 ? "21" : "20.5");
  center.setAttribute("text-anchor", "middle");
  center.setAttribute("dominant-baseline", "central");
  center.textContent = total === 0 ? "no runs yet" : `${total}`;
  root.appendChild(center);
  if (total > 0) {
    const sub = svg("text");
    sub.setAttribute("class", "donut-center sub");
    sub.setAttribute("x", "21");
    sub.setAttribute("y", "25");
    sub.setAttribute("text-anchor", "middle");
    sub.setAttribute("dominant-baseline", "central");
    sub.textContent = "submissions";
    root.appendChild(sub);
  }

  const legend = $("d-legend");
  legend.replaceChildren();
  for (const mode of FAILURE_MODES) {
    const n = agg.failure_modes[mode.key];
    const li = el("li");
    const sw = el("span", "swatch");
    sw.style.background = mode.color;
    li.appendChild(sw);
    li.appendChild(el("span", "lname", mode.label));
    li.appendChild(el("span", "lval", total === 0 ? "—" : `${n} · ${pctLabel(n, total)}`));
    legend.appendChild(li);
  }
}

// --- boot / refresh ------------------------------------------------------------

function showCards(show: boolean): void {
  for (const id of ["panel-a", "panel-b", "panel-c", "panel-d"]) {
    $(id).classList.toggle("hidden", !show);
  }
}

function renderAll(agg: Aggregate): void {
  renderStats(agg);
  renderPanelA(agg);
  renderPanelB(agg);
  renderPanelC(agg);
  renderPanelD(agg);
  showCards(true);
  $("status").textContent = "";
}

async function load(): Promise<void> {
  const status = $("status");
  const base = collectorUrl();
  if (base === null) {
    status.textContent = "The public dataset endpoint is not configured for this build.";
    showCards(false);
    return;
  }
  status.textContent = "loading…";
  let agg: Aggregate;
  try {
    const res = await fetch(`${base}/v1/aggregate`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    agg = (await res.json()) as Aggregate;
  } catch {
    status.textContent = "The public dataset is temporarily unavailable. Try again shortly.";
    showCards(false);
    return;
  }
  renderAll(agg);
}

function boot(): void {
  const refresh = $("refresh") as HTMLButtonElement;
  refresh.addEventListener("click", () => {
    refresh.disabled = true;
    void load().finally(() => {
      refresh.disabled = false;
    });
  });
  void load();
}

boot();
