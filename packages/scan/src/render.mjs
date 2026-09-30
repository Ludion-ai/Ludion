// Human output for `ludion scan`. Renders only the report object (never a raw record), so it
// can show nothing the JSON output does not.
const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");

export function renderText(r) {
  const out = [];
  const w = r.window.first ? `${r.window.first.slice(0, 16).replace("T", " ")} → ${r.window.last.slice(0, 16).replace("T", " ")} UTC` : "no timestamps";
  const formats = Object.entries(r.files.reduce((m, f) => ((m[f.format] = (m[f.format] ?? 0) + 1), m), {}))
    .map(([f, c]) => `${f}${c > 1 ? ` ×${c}` : ""}`).join(", ");
  out.push(`Ludion scan — ${n(r.totals.records)} requests in ${r.files.length} file${r.files.length === 1 ? "" : "s"} (${formats || "none"}), ${pct(r.totals.parsed, r.totals.records)} parsed`);
  out.push(`  ${w}`);
  for (const f of r.files) if (f.parse_rate != null && f.parse_rate < 0.99) out.push(`  ! ${f.name}: only ${pct(f.parsed, f.records)} of ${n(f.records)} lines parsed as ${f.format}`);
  for (const u of r.unrecognized) out.push(`  ! ${u.name}: format not recognised, skipped`);

  const c = r.classes;
  out.push("", `Automation: ${n(r.automation)} of ${n(r.totals.parsed)} requests (${pct(r.automation, r.totals.parsed)}) — none of it verifiable from a log`);
  out.push(`  DECLARED    ${n(c.DECLARED).padStart(9)}  named itself (a published agent token), no signature`);
  out.push(`  SUSPECTED   ${n(c.SUSPECTED).padStart(9)}  automation signals (HTTP libraries, headless browsers, no User-Agent)`);
  if (c.UNVERIFIED) out.push(`  UNVERIFIED  ${n(c.UNVERIFIED).padStart(9)}  carried a Web Bot Auth signature — only a Gate can check it`);
  out.push(`  (UNKNOWN    ${n(c.UNKNOWN).padStart(9)}  humans and everything else)`);

  const ops = Object.entries(r.operators).slice(0, 10), sig = Object.entries(r.signals).slice(0, 8);
  if (ops.length) { out.push("", "Who said who they were (unsigned, so anyone can say it):"); for (const [k, v] of ops) out.push(`  ${n(v).padStart(9)}  ${k}`); }
  if (sig.length) { out.push("", "Automation signals:"); for (const [k, v] of sig) out.push(`  ${n(v).padStart(9)}  ${k}`); }

  out.push("", "What automation touched (by route kind):", `  ${"kind".padEnd(10)}${"declared".padStart(10)}${"suspected".padStart(11)}${"unverified".padStart(12)}${"writes".padStart(9)}`);
  for (const [kind, v] of Object.entries(r.kinds)) {
    const auto = v.DECLARED + v.SUSPECTED + v.UNVERIFIED + v.SPOOFED + v.REVOKED;
    if (!auto) continue;
    out.push(`  ${kind.padEnd(10)}${n(v.DECLARED).padStart(10)}${n(v.SUSPECTED).padStart(11)}${n(v.UNVERIFIED).padStart(12)}${n(v.writes).padStart(9)}`);
  }

  out.push("", `▶ UNVERIFIED AUTOMATION ON CRITICAL ROUTES: ${n(r.critical.unverified_automation)}   (served: ${n(r.critical.served)})`);
  out.push(`  critical = ${r.critical.definition}`);
  out.push("  Each one was answered with no way to know whose agent it was, what it was allowed to do, or who pays if it broke something.");
  const crit = r.routes.filter((x) => x.critical > 0);
  if (crit.length) { out.push("", "Busiest critical routes (templated):"); for (const x of crit.slice(0, 10)) out.push(`  ${n(x.critical).padStart(9)}  ${x.route}  (${x.kind})`); }

  for (const note of r.notes) out.push("", `note: ${note}`);
  out.push("", "Next: install Ludion Gate at Pressure 0 (observe only) to verify signatures live → https://ludion.ai/gate");
  return out.join("\n");
}
