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

export function statTile(label: string, value: string, sub?: string): HTMLElement {
  const t = el("div", "lx-stat");
  t.append(el("p", "lx-stat-label", label));
  t.append(el("p", "lx-stat-num", value));
  if (sub !== undefined) t.append(el("p", "lx-stat-sub", sub));
  return t;
}

/** A monochrome routing ring. `pct` is 0..100 for the strong (on-device) arc. */
export function ring(pct: number, centerLabel: string): SVGSVGElement {
  const size = 116;
  const r = 48;
  const cx = size / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, role: "img" });
  svg.setAttribute("class", "lx-ring");
  svg.setAttribute("aria-label", `${Math.round(clamped)}% on device`);
  svg.append(svgEl("circle", { cx, cy: cx, r, class: "lx-ring-track" }));
  const arc = svgEl("circle", {
    cx,
    cy: cx,
    r,
    class: "lx-ring-arc",
    "stroke-dasharray": `${(clamped / 100) * c} ${c}`,
  });
  svg.append(arc);
  const text = svgEl("text", { x: cx, y: cx, class: "lx-ring-center" });
  text.textContent = centerLabel;
  svg.append(text);
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

/** A calm empty state for a single card. */
export function emptyState(head: string, sub: string): HTMLElement {
  const e = el("div", "lx-empty");
  e.append(el("p", "lx-empty-head", head));
  e.append(el("p", "lx-empty-sub", sub));
  return e;
}
