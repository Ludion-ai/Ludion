// `ludion scan <file|dir|-> … [--json] [--top N] [--format ID]`
import { scan, renderText, FORMAT_IDS } from "./index.mjs";

const USAGE = `usage: ludion scan <access.log|dir|-> … [--json] [--top N] [--format ${FORMAT_IDS.join("|")}]
  Formats are detected per file: nginx/Apache combined & common, CloudFront, IIS (W3C), AWS ALB,
  Caddy, Cloudflare Logpush, Vercel log drains, Fastly (JSON or syslog-framed), JSON lines. gzip ok.`;

/** @param {string[]} argv arguments after `scan` */
export async function main(argv, { stdout = process.stdout } = {}) {
  const inputs = [], opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--top") opts.top = Math.max(1, Number(argv[++i]) || 15);
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "-h" || a === "--help") { stdout.write(USAGE + "\n"); return 0; }
    else if (a.startsWith("--")) { stdout.write(`unknown option ${a}\n${USAGE}\n`); return 2; }
    else inputs.push(a);
  }
  if (!inputs.length) { stdout.write(USAGE + "\n"); return 2; }
  const report = await scan(inputs, opts);
  stdout.write((json ? JSON.stringify(report, null, 2) : renderText(report)) + "\n");
  return report.totals.records ? 0 : 1;
}
