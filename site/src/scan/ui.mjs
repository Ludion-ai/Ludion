// The /scan page: files in (drop or pick), the worker scans them, the report is drawn here.
// Every value is written with textContent, never as HTML. The report is exactly the CLI's
// (`ludion scan --json`), and it is shown verbatim in #scan-json.
import { renderText } from "@ludion/scan/web";
import { STRINGS, GATE_URL } from "./strings.mjs";

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v; else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

function table(head, rows, numeric) {
  return el("table", { class: "scan-table" },
    el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { scope: "col", class: numeric(i) ? "num" : null }, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => el("td", { class: numeric(i) ? "num" : null }, c))))));
}

function draw(out, r, t, fmt) {
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
  const c = r.classes;
  out.replaceChildren();

  out.append(el("section", { class: "scan-hero" },
    el("h2", {}, t.headline),
    el("p", { class: "scan-big" }, el("span", { id: "scan-critical" }, fmt(r.critical.unverified_automation))),
    el("p", {}, t.served(fmt(r.critical.served))),
    el("p", {}, t.because),
    el("p", { class: "scan-def" }, t.criticalIs, el("code", {}, r.critical.definition))));

  out.append(el("h3", {}, t.classesTitle),
    el("p", {}, t.of(fmt(r.automation), fmt(r.totals.parsed), pct(r.automation, r.totals.parsed))),
    table(t.classHead, ["DECLARED", "SUSPECTED", "UNVERIFIED", "UNKNOWN"].filter((k) => k !== "UNVERIFIED" || c.UNVERIFIED)
      .map((k) => [el("code", {}, k), fmt(c[k]), t.classes[k]]), (i) => i === 1));

  const crit = r.routes.filter((x) => x.critical > 0).slice(0, 10);
  if (crit.length) out.append(el("h3", {}, t.routesTitle), table(t.routeHead, crit.map((x) => [fmt(x.critical), el("code", {}, x.route), x.kind]), (i) => i === 0));

  const kinds = Object.entries(r.kinds).filter(([, v]) => v.DECLARED + v.SUSPECTED + v.UNVERIFIED + v.SPOOFED + v.REVOKED > 0);
  if (kinds.length) out.append(el("h3", {}, t.kindsTitle),
    table(t.kindHead, kinds.map(([k, v]) => [k, fmt(v.DECLARED), fmt(v.SUSPECTED), fmt(v.UNVERIFIED), fmt(v.writes)]), (i) => i > 0));

  const ops = Object.entries(r.operators).slice(0, 10), sig = Object.entries(r.signals).slice(0, 8);
  if (ops.length) out.append(el("h3", {}, t.operatorsTitle), table(t.operatorHead, ops.map(([k, v]) => [fmt(v), k]), (i) => i === 0));
  if (sig.length) out.append(el("h3", {}, t.signalsTitle), table(t.signalHead, sig.map(([k, v]) => [fmt(v), k]), (i) => i === 0));

  const notes = [r.no_user_agent_field ? t.noUa(fmt(r.no_user_agent_field)) : null, c.UNVERIFIED ? t.signed(fmt(c.UNVERIFIED)) : null].filter(Boolean);
  for (const n of notes) out.append(el("p", { class: "scan-note" }, n));

  out.append(el("h3", {}, t.filesTitle),
    table(t.fileHead, [
      ...r.files.map((f) => [f.name, f.format + (f.gzip ? " · gzip" : ""), fmt(f.records), pct(f.parsed, f.records)]),
      ...r.unrecognized.map((f) => [f.name, t.unrecognized, "", ""]),
    ], (i) => i > 1));

  out.append(el("h3", {}, t.nextTitle), el("p", {}, t.next, " ", el("a", { href: GATE_URL }, t.nextLink)),
    el("p", {}, t.cli, " ", el("code", {}, "npx ludion scan access.log")));

  const text = renderText(r), json = JSON.stringify(r, null, 2);
  const copy = el("button", { type: "button", class: "scan-button" }, t.copy);
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = t.copied; } catch { /* clipboard refused: nothing to do */ }
  });
  const save = el("button", { type: "button", class: "scan-button" }, t.download);
  save.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    el("a", { href: url, download: "ludion-scan.json" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  out.append(el("p", { class: "scan-actions" }, copy, save),
    el("details", {}, el("summary", {}, t.json), el("pre", { id: "scan-json" }, json)));
}

export function mount(root) {
  const t = STRINGS[root.dataset.lang] ?? STRINGS.en;
  const nf = new Intl.NumberFormat(t.locale);
  const fmt = (x) => nf.format(Number(x ?? 0));
  const input = root.querySelector("input[type=file]");
  const status = root.querySelector("#scan-status");
  const out = root.querySelector("#scan-result");
  const mb = (b) => (b / 1e6).toFixed(b < 1e7 ? 1 : 0);
  let worker = null;

  function start(files) {
    if (!files.length) return;
    worker?.terminate();
    worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    root.dataset.state = "reading";
    out.hidden = true;
    input.disabled = true;
    status.textContent = t.reading(0, mb(0));
    worker.onmessage = ({ data: m }) => {
      if (m.type === "progress") { status.textContent = t.reading(Math.floor((m.bytes / (m.total || 1)) * 100), mb(m.bytes)); return; }
      worker.terminate(); worker = null;
      input.disabled = false;
      input.value = "";
      if (m.type === "done") {
        draw(out, m.report, t, fmt);
        out.hidden = false;
        status.textContent = t.done(mb(m.bytes), (m.ms / 1000).toFixed(1));
        root.dataset.ms = String(m.ms);
        root.dataset.state = "done";
      } else {
        status.textContent = t.error + m.message;
        root.dataset.state = "error";
      }
    };
    worker.onerror = (e) => { worker?.terminate(); worker = null; input.disabled = false; status.textContent = t.error + (e.message || "worker"); root.dataset.state = "error"; };
    worker.postMessage({ files: [...files] });
  }

  input.addEventListener("change", () => start(input.files ?? []));
  root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("scan-over"); });
  root.addEventListener("dragleave", () => root.classList.remove("scan-over"));
  root.addEventListener("drop", (e) => { e.preventDefault(); root.classList.remove("scan-over"); start(e.dataTransfer?.files ?? []); });
  root.dataset.state = "idle";
}
