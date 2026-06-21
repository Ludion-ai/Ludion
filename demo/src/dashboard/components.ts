/*
 * Reusable design-system primitives for the workspace dashboard (2b-1). 2b-2
 * builds its sections out of these (and the tokens in dashboard.css), so the
 * look stays one system. Pure DOM construction — no data, no state.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an element with an optional class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Thin line icons (20x20, currentColor stroke). Keyed by nav section. */
const ICON_PATHS: Record<string, string[]> = {
  quickstart: ["M8 7l-4 5 4 5", "M16 7l4 5-4 5", "M13 5l-2 14"],
  overview: ["M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"],
  routing: ["M6 3v6a4 4 0 0 0 4 4h8", "M14 9l4 4-4 4", "M6 21v-6"],
  models: ["M12 3l8 4-8 4-8-4 8-4z", "M4 11l8 4 8-4", "M4 15l8 4 8-4"],
  relay: ["M4 5h16v6H4zM4 13h16v6H4z", "M8 8h.01M8 16h.01"],
  decisions: ["M8 6h12M8 12h12M8 18h12", "M3.5 6h.01M3.5 12h.01M3.5 18h.01"],
  savings: ["M3 17l5-5 4 4 8-8", "M16 8h5v5"],
  devices: ["M7 4h10v16H7z", "M11 18h2"],
  settings: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M3 12h3M18 12h3M12 3v3M12 18v3"],
  search: ["M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "M20 20l-4.3-4.3"],
};

export function icon(name: string, cls = "lx-ic"): SVGSVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" });
  svg.setAttribute("class", cls);
  for (const d of ICON_PATHS[name] ?? ICON_PATHS.overview!) {
    const path = svgEl("path", {
      d,
      stroke: "currentColor",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    svg.append(path);
  }
  return svg;
}

/** The brand hex mark, in brand red (colored via CSS `color`). */
export function hexMark(): SVGSVGElement {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  svg.setAttribute("class", "lx-brand-mark");
  const hex = svgEl("path", {
    d: "M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z",
    fill: "currentColor",
  });
  svg.append(hex);
  return svg;
}

export interface CardOpts {
  kicker?: string;
  span?: 4 | 6 | 8 | 12;
}

/** A surface card. Returns the card; append content to it. */
export function card(opts: CardOpts = {}): HTMLElement {
  const c = el("section", `lx-card lx-col-${opts.span ?? 12}`);
  if (opts.kicker) c.append(el("span", "lx-kicker", opts.kicker));
  return c;
}

export function statTile(label: string, value: string, sub?: string, viz?: Node): HTMLElement {
  const t = el("div", "lx-stat");
  t.append(el("p", "lx-stat-label", label));
  t.append(el("p", "lx-stat-num", value));
  if (sub !== undefined) t.append(el("p", "lx-stat-sub", sub));
  if (viz) {
    const v = el("div", "lx-stat-viz");
    v.append(viz);
    t.append(v);
  }
  return t;
}

/*
 * Empty-capable monochrome viz primitives (2b-1 re-skin). Each renders an
 * elegant skeleton when it has no data (empty ring, flat dashed baseline) —
 * never a fabricated value. All are pure SVG over data the caller already holds.
 */

/** A monochrome donut. `pct` is 0..100, or null for the empty skeleton. */
export function donut(pct: number | null, centerLabel: string): SVGSVGElement {
  const size = 132;
  const r = 54;
  const cx = size / 2;
  const c = 2 * Math.PI * r;
  const has = pct !== null;
  const clamped = Math.max(0, Math.min(100, pct ?? 0));
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, role: "img" });
  svg.setAttribute("class", "lx-donut");
  svg.setAttribute("aria-label", has ? `${Math.round(clamped)}% on device` : "no data yet");
  svg.append(svgEl("circle", { cx, cy: cx, r, class: "lx-donut-track" }));
  if (has) {
    svg.append(
      svgEl("circle", {
        cx,
        cy: cx,
        r,
        class: "lx-donut-arc",
        "stroke-dasharray": `${(clamped / 100) * c} ${c}`,
      }),
    );
  }
  const text = svgEl("text", { x: cx, y: cx, class: "lx-donut-center" });
  text.textContent = centerLabel;
  svg.append(text);
  return svg;
}

/** A 270° radial gauge. `fraction` is 0..1, or null for the empty skeleton. */
export function radialGauge(fraction: number | null, ariaLabel: string): SVGSVGElement {
  const size = 132;
  const r = 54;
  const cx = size / 2;
  const c = 2 * Math.PI * r;
  const sweep = 0.75; // 270° of the circle
  const has = fraction !== null;
  const f = Math.max(0, Math.min(1, fraction ?? 0));
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, role: "img" });
  svg.setAttribute("class", "lx-gauge");
  svg.setAttribute("aria-label", has ? ariaLabel : "no data yet");
  svg.append(
    svgEl("circle", { cx, cy: cx, r, class: "lx-gauge-track", "stroke-dasharray": `${sweep * c} ${c}` }),
  );
  if (has) {
    svg.append(
      svgEl("circle", {
        cx,
        cy: cx,
        r,
        class: "lx-gauge-arc",
        "stroke-dasharray": `${f * sweep * c} ${c}`,
      }),
    );
  }
  return svg;
}

/** A tiny trend sparkline. Empty array → a flat dashed baseline. */
export function sparkline(values: number[]): SVGSVGElement {
  const w = 120;
  const h = 34;
  const pad = 2;
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  svg.setAttribute("class", "lx-spark");
  if (values.length === 0) {
    svg.append(svgEl("line", { x1: pad, y1: h / 2, x2: w - pad, y2: h / 2, class: "lx-spark-base" }));
    return svg;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number): number => (n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad));
  const y = (v: number): number => h - pad - ((v - min) / span) * (h - 2 * pad);
  if (n === 1) {
    svg.append(svgEl("circle", { cx: w / 2, cy: y(values[0]!), r: 2, class: "lx-spark-dot" }));
    return svg;
  }
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  svg.append(svgEl("polyline", { points: pts, class: "lx-spark-line" }));
  return svg;
}

/** A filled area chart. Empty array → a dashed axis baseline. */
export function areaChart(values: number[]): SVGSVGElement {
  const w = 320;
  const h = 110;
  const pad = 4;
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", role: "img" });
  svg.setAttribute("class", "lx-area");
  if (values.length === 0) {
    svg.setAttribute("aria-label", "no data yet");
    svg.append(svgEl("line", { x1: pad, y1: h - pad, x2: w - pad, y2: h - pad, class: "lx-area-base" }));
    return svg;
  }
  const max = Math.max(...values, 0);
  const span = max || 1;
  const n = values.length;
  const x = (i: number): number => (n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad));
  const y = (v: number): number => h - pad - (v / span) * (h - 2 * pad);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const right = n === 1 ? w / 2 : w - pad;
  svg.append(svgEl("polygon", { points: `${pad},${h - pad} ${line} ${right},${h - pad}`, class: "lx-area-fill" }));
  svg.append(svgEl("polyline", { points: line, class: "lx-area-line" }));
  return svg;
}

export function badge(text: string): HTMLElement {
  const b = el("span", "lx-badge");
  b.append(el("span", "lx-dot"));
  b.append(document.createTextNode(text));
  return b;
}

export interface TableSpec {
  headers: string[];
  rows: Array<Array<{ text: string; mono?: boolean; tag?: boolean }>>;
}

export function table(spec: TableSpec): HTMLElement {
  const scroll = el("div", "lx-table-scroll");
  const t = el("table", "lx-table");
  const thead = el("thead");
  const htr = el("tr");
  for (const h of spec.headers) htr.append(el("th", undefined, h));
  thead.append(htr);
  t.append(thead);
  const tbody = el("tbody");
  for (const row of spec.rows) {
    const tr = el("tr");
    for (const cell of row) {
      const td = el("td", cell.mono ? "lx-mono" : undefined);
      if (cell.tag) {
        td.append(el("span", "lx-route-tag", cell.text));
      } else {
        td.textContent = cell.text;
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(tbody);
  scroll.append(t);
  return scroll;
}

/**
 * A monospace, copy-to-clipboard block. The text is set via textContent (never
 * innerHTML), so config values and URLs are never interpolated into markup.
 * `inline` renders a single-line field (a command / URL); otherwise a pre block.
 */
export function copyBlock(text: string, opts: { inline?: boolean; label?: string } = {}): HTMLElement {
  const wrap = el("div", opts.inline ? "lx-copy lx-copy-inline" : "lx-copy");
  const body = el(opts.inline ? "code" : "pre", "lx-copy-text");
  body.textContent = text;
  wrap.append(body);
  const btn = el("button", "lx-copy-btn", "Copy");
  btn.type = "button";
  btn.setAttribute("aria-label", opts.label ? `Copy ${opts.label}` : "Copy");
  btn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        btn.textContent = "Copied";
        window.setTimeout(() => (btn.textContent = "Copy"), 1200);
      },
      () => {
        btn.textContent = "Copy failed";
      },
    );
  });
  wrap.append(btn);
  return wrap;
}

/** A calm empty state for a single card. */
export function emptyState(head: string, sub: string): HTMLElement {
  const e = el("div", "lx-empty");
  e.append(el("p", "lx-empty-head", head));
  e.append(el("p", "lx-empty-sub", sub));
  return e;
}
