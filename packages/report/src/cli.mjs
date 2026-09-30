// `ludion report --events <file|-> [--date YYYY-MM-DD] [--tz ZONE] [--site ID] [--lang ja|en]
//                [--format text|html|json|subject] [--out FILE]`
// Reads files (gzip ok) or stdin and writes stdout or --out. Nothing else: no network, no mail.
import fs from "node:fs";
import zlib from "node:zlib";
import { buildReport, renderText, renderHtml, subject, addDays, dateIn, LANGS } from "./index.mjs";

const FORMATS = ["text", "html", "json", "subject"];
const USAGE = `usage: ludion report --events <events.ndjson|-> [--date YYYY-MM-DD] [--tz Asia/Tokyo] [--site ID]
                     [--lang ${LANGS.join("|")}] [--format ${FORMATS.join("|")}] [--out FILE]
  Builds the daily report for one site and one day (default: yesterday in --tz, default UTC)
  from the Gate's metadata events. It never sends anything; pipe the HTML or text to your mailer.`;

function readInput(file, stdin) {
  const buf = file === "-" ? fs.readFileSync(stdin ?? 0) : fs.readFileSync(file);
  return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8");
}

/** @param {string[]} argv arguments after `report` */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, now = Date.now(), stdin } = {}) {
  const o = { tz: "UTC", lang: "en", format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--events") o.events = v();
    else if (a === "--date") o.date = v();
    else if (a === "--tz") o.tz = v();
    else if (a === "--site") o.site = v();
    else if (a === "--lang") o.lang = v();
    else if (a === "--format") o.format = v();
    else if (a === "--out") o.out = v();
    else if (a === "-h" || a === "--help") { stdout.write(USAGE + "\n"); return 0; }
    else { stderr.write(`unknown argument ${a}\n${USAGE}\n`); return 2; }
  }
  if (!o.events) { stderr.write(USAGE + "\n"); return 2; }
  if (!LANGS.includes(o.lang)) { stderr.write(`--lang must be one of ${LANGS.join(", ")}\n`); return 2; }
  if (!FORMATS.includes(o.format)) { stderr.write(`--format must be one of ${FORMATS.join(", ")}\n`); return 2; }
  let text, s;
  try { text = readInput(o.events, stdin); } catch (e) { stderr.write(`cannot read ${o.events}: ${e.code ?? e.message}\n`); return 2; }
  try {
    const date = o.date ?? (() => { try { return addDays(dateIn(o.tz, now), -1); } catch { return undefined; } })();
    s = buildReport(text, { date, tz: o.tz, site: o.site });
  } catch (e) { stderr.write(`${e.message}\n`); return 2; }
  const out = o.format === "json" ? JSON.stringify(s, null, 2) + "\n"
    : o.format === "html" ? renderHtml(s, o.lang)
      : o.format === "subject" ? subject(s, o.lang) + "\n"
        : renderText(s, o.lang);
  if (o.out) fs.writeFileSync(o.out, out); else stdout.write(out);
  return 0;
}
