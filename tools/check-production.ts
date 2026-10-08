// Checks production right after a deploy (deploy.yml). Exits non-zero if any check fails.
//   1. index.json's built_at is newer than this job's start (waits up to 2 minutes for the new version).
//   2. /mcp answers initialize with 200.
//   3. ludion_ask about distutils returns a lesson with "Taught by @".
// Usage: STARTED_AT=<ISO time the job started> node tools/check-production.ts [site]
const site = process.argv[2] ?? "https://ludion.ai";
const startedAt = Date.parse(process.env.STARTED_AT ?? "");
const WAIT_MS = 120_000;
const QUESTION = "What changed about distutils in Python 3.12?";

if (Number.isNaN(startedAt)) {
  console.error("STARTED_AT is missing or not a date. Set it to the time this job started, for example 2026-10-08T03:00:00Z.");
  process.exit(2);
}

async function newIndex(): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  let last = "none";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${site}/index.json?deploy-check=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
      const builtAt = ((await res.json()) as { built_at?: string }).built_at ?? "none";
      last = builtAt;
      if (res.ok && Date.parse(builtAt) > startedAt) return builtAt;
    } catch {
      // Not answering yet; try again.
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`index.json still shows built_at ${last}, not newer than this job's start (${process.env.STARTED_AT}). The new version isn't live.`);
}

/** One MCP request over Streamable HTTP; the reply may be JSON or a server-sent event. */
async function rpc(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; message: any }> {
  const res = await fetch(`${site}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("")
    : text;
  return { status: res.status, message: json ? JSON.parse(json) : null };
}

const failures: string[] = [];
try {
  console.log(`index.json built_at ${await newIndex()} (job started ${process.env.STARTED_AT})`);
} catch (err) {
  failures.push((err as Error).message);
}

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ludion-deploy-check", version: "1" } },
}).catch((err: Error) => ({ status: 0, message: { error: err.message } }));
if (init.status === 200 && init.message?.result) {
  console.log(`/mcp initialize: 200, protocol ${init.message.result.protocolVersion}`);
} else {
  failures.push(`/mcp initialize answered ${init.status}: ${JSON.stringify(init.message).slice(0, 200)}`);
}

const version = init.message?.result?.protocolVersion ?? "2025-06-18";
const ask = await rpc(
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ludion_ask", arguments: { question: QUESTION } } },
  { "mcp-protocol-version": version },
).catch((err: Error) => ({ status: 0, message: { error: err.message } }));
const answer: string = ask.message?.result?.content?.[0]?.text ?? "";
if (ask.status === 200 && answer.includes("Taught by @")) {
  console.log(`ludion_ask "${QUESTION}":\n${answer}`);
} else {
  failures.push(`ludion_ask answered ${ask.status} without "Taught by @": ${(answer || JSON.stringify(ask.message)).slice(0, 300)}`);
}

if (failures.length > 0) {
  console.error(`\nProduction check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nProduction check passed.");
