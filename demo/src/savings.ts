import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
import hexMarkUrl from "../../assets/ludion-hex-mark.svg";
import { PRESET_PRICING, PricingStore, SavingsLedger } from "ludion-router/savings";
import type { SavingsSummary } from "ludion-router/savings";

/**
 * Gate 6-B — the savings dashboard. Renders the 6-A SavingsSummary, nothing
 * more: no computation, no network, no router change. Reads the ledger that the
 * demo (same origin) accrues via its opt-in wiring. The aesthetic is the 2.6
 * monochrome system; the hero number is the only large element, ink-black, like
 * a bank balance. Green appears only as meaning (saved amount / local share).
 */

const ledger = new SavingsLedger();
const pricing = new PricingStore();

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const brandMark = document.getElementById("brand-mark");
if (brandMark instanceof HTMLImageElement) brandMark.src = hexMarkUrl;

const root = $("#savings");

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Fraction digits that keep a non-zero sub-cent amount from rendering as $0.00. */
function usdFractionDigits(amount: number): number {
  const a = Math.abs(amount);
  if (a === 0 || a >= 0.005) return 2; // whole cents
  if (a >= 0.00005) return 4;
  return 6; // very small but real — never collapse to $0.00
}

function formatUSD(amount: number, currency: string): string {
  // Fixed en-US locale (not the browser locale) for stable rendering, with
  // sub-cent precision so a real would-be saving never rounds away to $0.00.
  const maximumFractionDigits = usdFractionDigits(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits,
    }).format(amount);
  } catch {
    // Unknown currency code → plain number with the code appended.
    return `${amount.toFixed(maximumFractionDigits)} ${currency}`;
  }
}

/** Illustrative request rate for the savings scale projection. */
const PROJECTION_REQ_PER_DAY = 1000;

/** "at N req/day ≈ $X/mo" projected from the observed per-request saving. */
function projectionLine(s: SavingsSummary): string {
  const perReq = s.local_count > 0 ? s.total_saved / s.local_count : 0;
  const monthly = perReq * PROJECTION_REQ_PER_DAY * 30;
  return `at ${PROJECTION_REQ_PER_DAY.toLocaleString("en-US")} req/day ≈ ${formatUSD(monthly, s.currency)}/mo`;
}

/** UTC-safe pretty date from a "YYYY-MM-DD" string (no Date timezone shift). */
function prettyDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return day;
  }
}

// --- panels -------------------------------------------------------------------

function heroPanel(s: SavingsSummary): HTMLElement {
  const wrap = el("section", "card s-hero");
  wrap.append(el("span", "s-kicker", "TOTAL SAVED"));
  wrap.append(el("p", "s-hero-num", formatUSD(s.total_saved, s.currency)));
  const sub = el(
    "p",
    "s-hero-sub",
    `across ${s.local_count.toLocaleString()} request${s.local_count === 1 ? "" : "s"} that ran on this device instead of the API`,
  );
  wrap.append(sub);
  if (s.local_count > 0) wrap.append(el("p", "s-hero-proj", projectionLine(s)));
  return wrap;
}

function basisPanel(s: SavingsSummary, onChange: () => void): HTMLElement {
  const wrap = el("section", "card s-basis");

  const line = el("p", "s-basis-line");
  const basis = pricing.resolveBasis();
  line.append(document.createTextNode(`vs ${basis.label} pricing, as of ${basis.price_as_of}`));

  if (s.estimated_fraction > 0) {
    line.append(el("span", "s-sep", " · "));
    line.append(el("span", "s-muted", `${Math.round(s.estimated_fraction * 100)}% estimated`));
  }
  if (!basis.verified) {
    line.append(el("span", "s-sep", " · "));
    line.append(el("span", "s-muted", "unverified price"));
  }

  const change = el("button", "s-change", "change");
  change.type = "button";
  change.addEventListener("click", onChange);
  line.append(document.createTextNode(" "));
  line.append(change);

  wrap.append(line);
  return wrap;
}

function pickerPanel(onApply: () => void): HTMLElement {
  const wrap = el("section", "card s-picker");
  wrap.append(el("span", "s-kicker", "COUNTERFACTUAL PRICING"));
  wrap.append(
    el(
      "p",
      "s-muted s-picker-help",
      "Which API would these requests have used? Savings are priced against it.",
    ),
  );

  const current = pricing.resolveBasis();

  // Preset select.
  const selWrap = el("label", "s-row");
  selWrap.append(el("span", "s-label", "Model"));
  const select = el("select", "s-input");
  for (const m of PRESET_PRICING.models) {
    const opt = el("option", undefined, `${m.label} (as of ${m.price_as_of})`);
    opt.value = m.id;
    if (!current.overridden && current.model === m.id) opt.selected = true;
    select.append(opt);
  }
  selWrap.append(select);
  wrap.append(selWrap);

  // Manual override.
  const inWrap = el("label", "s-row");
  inWrap.append(el("span", "s-label", "Custom input $/1M"));
  const inInput = el("input", "s-input");
  inInput.type = "number";
  inInput.min = "0";
  inInput.step = "0.01";
  inInput.placeholder = "leave blank to use preset";
  if (current.overridden) inInput.value = String(current.input_per_1m);
  inWrap.append(inInput);
  wrap.append(inWrap);

  const outWrap = el("label", "s-row");
  outWrap.append(el("span", "s-label", "Custom output $/1M"));
  const outInput = el("input", "s-input");
  outInput.type = "number";
  outInput.min = "0";
  outInput.step = "0.01";
  outInput.placeholder = "leave blank to use preset";
  if (current.overridden) outInput.value = String(current.output_per_1m);
  outWrap.append(outInput);
  wrap.append(outWrap);

  const apply = el("button", "s-apply", "apply");
  apply.type = "button";
  apply.addEventListener("click", () => {
    const inV = parseFloat(inInput.value);
    const outV = parseFloat(outInput.value);
    if (Number.isFinite(inV) && Number.isFinite(outV) && inV >= 0 && outV >= 0) {
      pricing.setOverride({ input_per_1m: inV, output_per_1m: outV });
    } else {
      pricing.setOverride(null);
      pricing.selectModel(select.value);
    }
    onApply();
  });
  wrap.append(apply);
  return wrap;
}

function splitPanel(s: SavingsSummary): HTMLElement {
  const wrap = el("section", "card s-split");
  wrap.append(el("span", "s-kicker", "WHERE REQUESTS RAN"));

  const total = s.local_count + s.server_count;
  const localPct = total === 0 ? 0 : (s.local_count / total) * 100;

  const bar = el("div", "s-bar");
  const localSeg = el("div", "s-bar-local");
  localSeg.style.width = `${localPct}%`;
  const serverSeg = el("div", "s-bar-server");
  serverSeg.style.width = `${100 - localPct}%`;
  bar.append(localSeg, serverSeg);
  wrap.append(bar);

  const legend = el("p", "s-legend");
  legend.append(el("span", "s-dot-local"));
  legend.append(
    document.createTextNode(` ${s.local_count.toLocaleString()} on device`),
  );
  legend.append(el("span", "s-sep", "   "));
  legend.append(el("span", "s-dot-server"));
  legend.append(
    document.createTextNode(` ${s.server_count.toLocaleString()} on server`),
  );
  wrap.append(legend);
  return wrap;
}

function sparklinePanel(s: SavingsSummary): HTMLElement | null {
  // A one-day "trend" is noise — omit chrome rather than draw it.
  if (s.by_day.length <= 1) return null;

  const wrap = el("section", "card s-trend");
  wrap.append(el("span", "s-kicker", "SAVED OVER TIME"));

  const days = s.by_day;
  const max = Math.max(...days.map((d) => d.saved), 0);
  const W = 320;
  const H = 56;
  const gap = 2;
  const n = days.length;
  const bw = Math.max(1, (W - gap * (n - 1)) / n);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "s-spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Daily savings across ${n} days`);

  days.forEach((d, i) => {
    const h = max === 0 ? 0 : (d.saved / max) * (H - 6);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(i * (bw + gap)));
    rect.setAttribute("y", String(H - h));
    rect.setAttribute("width", String(bw));
    rect.setAttribute("height", String(h));
    rect.setAttribute("class", "s-spark-bar");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${prettyDay(d.day)}: ${formatUSD(d.saved, s.currency)}`;
    rect.append(title);
    svg.append(rect);
  });

  // single hairline baseline
  const base = document.createElementNS("http://www.w3.org/2000/svg", "line");
  base.setAttribute("x1", "0");
  base.setAttribute("y1", String(H));
  base.setAttribute("x2", String(W));
  base.setAttribute("y2", String(H));
  base.setAttribute("class", "s-spark-base");
  svg.append(base);

  wrap.append(svg);

  const range = el(
    "p",
    "s-muted s-trend-range",
    `${prettyDay(days[0]!.day)} – ${prettyDay(days[n - 1]!.day)}`,
  );
  wrap.append(range);
  return wrap;
}

function emptyPanel(): HTMLElement {
  const wrap = el("section", "card s-empty");
  wrap.append(el("p", "s-empty-head", "No requests recorded yet."));
  wrap.append(
    el(
      "p",
      "s-muted",
      "Savings appear here once Ludion runs on this device.",
    ),
  );
  const back = el("a", "s-empty-link", "Open the demo and ask something →");
  back.href = "./";
  wrap.append(back);
  return wrap;
}

// --- render -------------------------------------------------------------------

let pickerOpen = false;

function render(): void {
  const s = ledger.summary();
  root.replaceChildren();

  if (s.total_requests === 0) {
    root.append(emptyPanel());
    return;
  }

  root.append(heroPanel(s));
  root.append(basisPanel(s, () => {
    pickerOpen = !pickerOpen;
    render();
  }));
  if (pickerOpen) {
    root.append(
      pickerPanel(() => {
        pickerOpen = false;
        render();
      }),
    );
  }
  root.append(splitPanel(s));
  const trend = sparklinePanel(s);
  if (trend) root.append(trend);
}

render();
