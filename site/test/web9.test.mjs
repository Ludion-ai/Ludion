// WEB-9 (+, pair WEB-5): the build that deploys, run as it deploys (site/edge in workerd, wrangler
// dev), is complete in both languages and scores Lighthouse mobile ≥95 in Performance,
// Accessibility, Best Practices and SEO on one page per template, in English and Japanese.
// The Lighthouse runner is first shown to fail a planted degraded page, so a pass means something.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildSite } from "../build.mjs";
import { startEdge } from "./edge.mjs";
import { lighthouseRunner, MIN_SCORE } from "./lighthouse.mjs";
import { pairing, templatePages, urlOf } from "./pages.mjs";

// The median of three runs per page: CI machines are busy, and the bar stays MIN_SCORE.
const RUNS = 3;
let dist, edge, lh;
before(async () => { dist = buildSite(); edge = await startEdge({ dist }); lh = await lighthouseRunner(); });
after(async () => { await lh?.close(); await edge?.stop(); });

test("WEB-9: every page exists in English and Japanese, with the right lang", () => {
  const p = pairing(dist);
  assert.deepEqual(p.problems, []);
  assert.ok(p.en > 5 && p.en === p.ja, `${p.en} English, ${p.ja} Japanese pages`);
});

test("WEB-9: the Lighthouse check fails a degraded page (planted)", async () => {
  const bad = `<!doctype html><html><head><title>x</title><script>const t=Date.now();while(Date.now()-t<3000){}</script></head>
    <body><img src="/x.png"><a href="#"></a><input><div style="color:#ccc;background:#ddd">low contrast</div></body></html>`;
  const srv = http.createServer((q, s) => { s.writeHead(q.url === "/" ? 200 : 404, { "content-type": "text/html" }); s.end(q.url === "/" ? bad : ""); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await lh.audit(`http://127.0.0.1:${srv.address().port}/`);
    assert.ok(r.failing.length > 0, `planted page scored ${JSON.stringify(r.scores)}`);
  } finally { srv.close(); }
});

test("WEB-9: Lighthouse mobile ≥95 in all four categories, one page per template, English and Japanese", async () => {
  const rows = [], failing = [];
  for (const f of templatePages()) {
    const r = await lh.auditMedian(edge.origin + urlOf(f), RUNS);
    rows.push(`${urlOf(f)} ${Object.values(r.scores).join("/")}`);
    for (const x of r.failing) failing.push(`${urlOf(f)}: ${x}`);
  }
  assert.deepEqual(failing, [], `below ${MIN_SCORE}`);
  const min = Math.min(...rows.flatMap((r) => r.split(" ")[1].split("/").map(Number)));
  console.log(`WEB-9: ${rows.length} pages (${rows.length / 2} templates × en, ja), lowest median score ${min} (${RUNS} runs each)`);
});
