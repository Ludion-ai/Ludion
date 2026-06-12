/**
 * CLI: pnpm pull-submissions (operator-run, decisions F-13)
 *
 * Lists new submissions in R2 via the collector's read-only admin surface,
 * validates each with the same schema validator the worker uses, and lands
 * them into bench/results/ as `web-{label}-{YYYYMMDDTHHMMSS}.json` with an
 * injected `"source": "web-submission"` provenance field.
 *
 * Idempotent: keys whose target filename already exists are skipped. The
 * script never deletes or mutates anything in R2 (read-only by construction).
 * The operator reviews `git diff`, commits, and reruns `pnpm supplier-table`.
 *
 * Env: COLLECTOR_URL (e.g. https://ludion-collector.<account>.workers.dev)
 *      COLLECTOR_ADMIN_TOKEN (set with `wrangler secret put ADMIN_TOKEN`)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBenchDocument } from "../../bench/src/schema";

const resultsDir = fileURLToPath(new URL("../../bench/results/", import.meta.url));

const baseUrl = process.env.COLLECTOR_URL?.replace(/\/$/, "");
const token = process.env.COLLECTOR_ADMIN_TOKEN;
if (!baseUrl || !token) {
  console.error("set COLLECTOR_URL and COLLECTOR_ADMIN_TOKEN (see collector/wrangler.toml header)");
  process.exit(1);
}

async function adminGet(path: string): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  }
  return res;
}

/** Same sanitation as the bench's exportFilename, plus lowercase per results/README. */
function sanitizeLabel(label: string): string {
  return (
    (label || "unlabeled")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unlabeled"
  );
}

function timestampFrom(receivedAt: string): string {
  // 2026-06-12T10:30:00.000Z -> 20260612T103000
  return receivedAt.replace(/[-:]/g, "").slice(0, 15);
}

async function listAllKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page = (await (await adminGet(`/v1/admin/list${query}`)).json()) as {
      keys: string[];
      truncated: boolean;
      cursor: string | null;
    };
    keys.push(...page.keys);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor !== null);
  return keys;
}

const keys = await listAllKeys();
console.log(`R2 holds ${keys.length} submission object(s) (authoritative count, decisions Q4)`);

const existing = new Set(readdirSync(resultsDir));
let landed = 0;
let skipped = 0;
let corrupt = 0;
let collisions = 0;

for (const key of keys) {
  const raw = await (await adminGet(`/v1/admin/object?key=${encodeURIComponent(key)}`)).text();

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`  CORRUPT (unparseable, excluded): ${key}`);
    corrupt++;
    continue;
  }
  const result = validateBenchDocument(doc);
  if (!result.ok) {
    console.error(`  CORRUPT (schema, excluded): ${key}: ${result.errors.slice(0, 3).join("; ")}`);
    corrupt++;
    continue;
  }

  const device = doc.device as { operator_label: string };
  const receivedAt = typeof doc.received_at === "string" ? doc.received_at : new Date().toISOString();
  const filename = `web-${sanitizeLabel(device.operator_label)}-${timestampFrom(receivedAt)}.json`;
  const landedDoc = { ...doc, source: "web-submission" };
  const content = JSON.stringify(landedDoc, null, 2) + "\n";

  if (existing.has(filename)) {
    // Idempotency: identical content = this object landed on a previous run.
    // Different content = a genuine collision (same label, same second from a
    // distinct object) — left for the operator, never silently overwritten.
    const prior = readFileSync(join(resultsDir, filename), "utf-8");
    if (prior === content) {
      skipped++;
    } else {
      console.error(`  COLLISION (left untouched, resolve manually): ${filename} vs ${key}`);
      collisions++;
    }
    continue;
  }

  writeFileSync(join(resultsDir, filename), content);
  existing.add(filename);
  console.log(`  landed: ${filename}  (from ${key})`);
  landed++;
}

const stats = (await (await fetch(`${baseUrl}/v1/stats`)).json()) as { total_submissions: number };
console.log(
  `done: ${landed} landed, ${skipped} already present, ${corrupt} corrupt (excluded), ${collisions} collision(s). ` +
    `stats counter says ${stats.total_submissions}; reconcile if drifted:\n` +
    `  npx wrangler kv key put --binding COLLECTOR_KV stats:total "${keys.length}" --remote`,
);
if (landed > 0) {
  console.log("review `git diff bench/results/`, commit, then run `pnpm supplier-table`.");
}
