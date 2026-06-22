/*
 * The Overview screen (Workspace 2b-1). Every card is fed from the client-side
 * SavingsLedger snapshot/summary (§1). When there is no client-side data it
 * renders the empty cards plus the first-run onboarding (§5) — never fake
 * numbers. Config (read-only) only personalises the onboarding copy.
 */
import type { SavingsSummary } from "ludion-router/savings";
import type { StoredConfig } from "ludion-workspace/schema";
import {
  areaChart,
  badge,
  card,
  donut,
  el,
  emptyState,
  radialGauge,
  sparkline,
  statTile,
  table,
} from "./components";
import {
  dailySeries,
  hasData,
  overviewStats,
  recentDecisions,
  topModelsByShare,
  type Snapshot,
} from "./shape";

export interface OverviewData {
  snapshot: Snapshot;
  summary: SavingsSummary;
  config: StoredConfig | null;
  /** Per-scope page subtitle; falls back to the this-device copy when absent. */
  subtitle?: string;
}

const DEVICE_SUBTITLE =
  "Routing on this device. Nothing is sent by default; with telemetry on, only anonymized metadata (never your prompts) leaves the device.";

const EM_DASH = "—";

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
    return `${amount.toFixed(maximumFractionDigits)} ${currency}`;
  }
}

/** Illustrative request rate for the savings scale projection. */
const PROJECTION_REQ_PER_DAY = 1000;

/** "at N req/day ≈ $X/mo" projected from the observed per-request saving. */
function projectionLine(summary: SavingsSummary): string {
  const perReq = summary.local_count > 0 ? summary.total_saved / summary.local_count : 0;
  const monthly = perReq * PROJECTION_REQ_PER_DAY * 30;
  return `at ${PROJECTION_REQ_PER_DAY.toLocaleString("en-US")} req/day ≈ ${formatUSD(monthly, summary.currency)}/mo`;
}

function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatWhen(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(t));
  } catch {
    return ts;
  }
}

function pageHead(subtitle?: string): HTMLElement {
  const head = el("div", "lx-page-head");
  const left = el("div");
  left.append(el("h1", "lx-page-title", "Overview"));
  left.append(el("p", "lx-page-sub", subtitle ?? DEVICE_SUBTITLE));
  head.append(left);
  // Time-window control: display-only in 2b-1 (§4).
  const win = el("span", "lx-window", "Last 30 days");
  win.setAttribute("aria-disabled", "true");
  head.append(win);
  return head;
}

function statsRow(data: OverviewData): HTMLElement {
  const wrap = el("section", "lx-stats lx-col-12");
  if (!hasData(data.snapshot)) {
    // Empty = elegant skeletons (flat baselines, empty gauge), never fake values.
    wrap.append(statTile("Requests routed", EM_DASH, "no requests yet", sparkline([])));
    wrap.append(statTile("On-device", EM_DASH, "no requests yet", sparkline([])));
    wrap.append(statTile("Success rate", EM_DASH, "no requests yet", radialGauge(null, "")));
    wrap.append(statTile("Cost saved", EM_DASH, "no requests yet", sparkline([])));
    return wrap;
  }
  const s = overviewStats(data.snapshot, data.summary);
  const series = dailySeries(data.summary);
  wrap.append(
    statTile(
      "Requests routed",
      s.routed.toLocaleString(),
      `${s.local.toLocaleString()} on device · ${s.server.toLocaleString()} fallback`,
      sparkline(series.routed),
    ),
  );
  wrap.append(
    statTile("On-device", formatPct(s.localPct / 100), "of routed requests", sparkline(series.local)),
  );
  // No honest per-day success series (see shape.dailySeries); gauge the aggregate.
  wrap.append(
    statTile(
      "Success rate",
      s.successRate === null ? EM_DASH : formatPct(s.successRate),
      "requests completed",
      radialGauge(s.successRate, s.successRate === null ? "" : formatPct(s.successRate)),
    ),
  );
  wrap.append(
    statTile(
      "Cost saved",
      formatUSD(data.summary.total_saved, data.summary.currency),
      `vs ${data.summary.pricing_basis.model} pricing`,
      sparkline(series.saved),
    ),
  );
  return wrap;
}

function routingCard(data: OverviewData): HTMLElement {
  const c = card({ kicker: "Routing", span: 4 });
  if (!hasData(data.snapshot)) {
    c.append(donut(null, EM_DASH));
    c.append(emptyState("Nothing routed yet", "On-device vs fallback share appears after your first request."));
    return c;
  }
  const s = overviewStats(data.snapshot, data.summary);
  const wrap = el("div", "lx-ring-wrap");
  wrap.append(donut(s.localPct, formatPct(s.localPct / 100)));
  const legend = el("div", "lx-legend");
  const r1 = el("div", "lx-legend-row");
  r1.append(el("span", "lx-dot lx-dot-strong"));
  r1.append(document.createTextNode("on device "));
  r1.append(el("span", "lx-legend-num", s.local.toLocaleString()));
  const r2 = el("div", "lx-legend-row");
  r2.append(el("span", "lx-dot lx-dot-dim"));
  r2.append(document.createTextNode("fallback "));
  r2.append(el("span", "lx-legend-num", s.server.toLocaleString()));
  const r3 = el("div", "lx-legend-row");
  r3.append(document.createTextNode("total "));
  r3.append(el("span", "lx-legend-num", s.routed.toLocaleString()));
  legend.append(r1, r2, r3);
  wrap.append(legend);
  c.append(wrap);
  return c;
}

function savingsCard(data: OverviewData): HTMLElement {
  const c = card({ kicker: "Savings", span: 4 });
  if (!hasData(data.snapshot) || data.summary.local_count === 0) {
    c.append(areaChart([]));
    c.append(emptyState("No savings yet", "Savings accrue when requests run on this device instead of the API."));
    return c;
  }
  c.append(el("p", "lx-save-num", formatUSD(data.summary.total_saved, data.summary.currency)));
  const n = data.summary.local_count;
  c.append(
    el(
      "p",
      "lx-save-sub",
      `${formatUSD(data.summary.total_saved, data.summary.currency)} would-be → ${formatUSD(0, data.summary.currency)} actual, across ${n.toLocaleString()} on-device request${n === 1 ? "" : "s"}`,
    ),
  );
  c.append(el("p", "lx-save-proj", projectionLine(data.summary)));
  c.append(areaChart(dailySeries(data.summary).saved));
  return c;
}

function modelsCard(data: OverviewData): HTMLElement {
  const c = card({ kicker: "Models", span: 4 });
  const top = topModelsByShare(data.snapshot);
  if (top.length === 0) {
    c.append(emptyState("No models routed yet", "Top models by routing share appear here."));
    return c;
  }
  const list = el("div", "lx-models");
  for (const m of top) {
    const row = el("div", "lx-model-row");
    const meta = el("div", "lx-model-meta");
    meta.append(el("div", "lx-model-name", m.label));
    const bar = el("div", "lx-model-share");
    const fill = el("span");
    fill.style.width = `${Math.round(m.share * 100)}%`;
    bar.append(fill);
    meta.append(bar);
    row.append(meta);
    if (m.status) row.append(badge(m.status));
    list.append(row);
  }
  c.append(list);
  return c;
}

function recentCard(data: OverviewData): HTMLElement {
  const c = card({ kicker: "Recent decisions", span: 12 });
  const rows = recentDecisions(data.snapshot);
  if (rows.length === 0) {
    c.append(emptyState("No decisions yet", "Each routing decision on this device shows up here — time, model, routing, rule, tokens."));
    return c;
  }
  c.append(
    table({
      headers: ["Time", "Model", "Routing", "Rule", "Tokens in→out"],
      rows: rows.map((r) => [
        { text: formatWhen(r.ts) },
        { text: r.model, mono: true },
        { text: r.routing, tag: true },
        { text: r.rule, mono: true },
        {
          text: `${r.tokensIn ?? EM_DASH}→${r.tokensOut ?? EM_DASH}`,
          mono: true,
        },
      ]),
    }),
  );
  return c;
}

function onboarding(config: StoredConfig | null): HTMLElement {
  const model = config?.fallback?.model;
  const relay = config?.relayUrl;
  const o = el("section", "lx-onboard lx-col-12");
  o.append(el("h2", "lx-onboard-title", "Get your first decision"));
  o.append(
    el(
      "p",
      "lx-onboard-lead",
      "Ludion decides per request whether to run on this device or fall back to your endpoint. Wire it up and your first decision lands here.",
    ),
  );
  const steps = el("ol", "lx-steps");
  // Sub content is built from DOM nodes (never innerHTML): `code` parts may
  // carry user-stored config values, so we never interpolate them into markup.
  const step = (title: string, ...sub: Array<Node | string>): HTMLElement => {
    const li = el("li", "lx-step");
    const body = el("div", "lx-step-body");
    body.append(el("p", "lx-step-title", title));
    const subEl = el("p", "lx-step-sub");
    subEl.append(...sub);
    body.append(subEl);
    li.append(body);
    return li;
  };
  const code = (text: string): HTMLElement => el("code", undefined, text);
  steps.append(
    model
      ? step("Pick a fallback model", "Configured: ", code(model))
      : step("Pick a fallback model", "Choose the model server-routed requests use."),
  );
  steps.append(
    relay
      ? step("Deploy a relay", "Relay: ", code(relay))
      : step("Deploy a relay", "Keep your provider key server-side behind a relay."),
  );
  steps.append(step("Drop in one import line", "Add ", code("ludion-router"), " and wire ", code("onDecision"), "."));
  steps.append(step("Make a request", "Your first decision appears in Recent decisions above."));
  o.append(steps);
  const cta = el("a", "lx-btn lx-btn-primary", "Pick a fallback model");
  cta.setAttribute("href", "#models");
  o.append(cta);
  return o;
}

export function renderOverview(data: OverviewData): HTMLElement {
  const root = el("div");
  root.append(pageHead(data.subtitle));
  const grid = el("div", "lx-grid");
  grid.append(statsRow(data));
  grid.append(routingCard(data));
  grid.append(savingsCard(data));
  grid.append(modelsCard(data));
  grid.append(recentCard(data));
  if (!hasData(data.snapshot)) grid.append(onboarding(data.config));
  root.append(grid);
  return root;
}
