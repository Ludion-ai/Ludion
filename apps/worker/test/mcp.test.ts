// /mcp inside workerd, against the built site's index.json. Asserts the exact text worker.md specifies.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ASK_DESCRIPTION, NO_MATCH, formatAsk, type AskLesson } from "../src/mcp/ask.ts";
import { SERVER_INSTRUCTIONS } from "../src/mcp/server.ts";
import { lessonsIndex, resetLessonsIndex } from "../src/lessons-index.ts";

let nextId = 1;

/** One JSON-RPC call over Streamable HTTP; accepts a JSON or an SSE answer. */
async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(
    new Request("https://ludion.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  const text = await res.text();
  const body = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).pop()
    : text ? JSON.parse(text) : undefined;
  return { status: res.status, body, res };
}

const ask = (args: Record<string, unknown>) => rpc("tools/call", { name: "ludion_ask", arguments: args });

interface IndexJson {
  lessons: { id: string; subject: string; version?: string; claim: string; teacher: string; teacher_id: number; verified_by: string; verified_at: string }[];
}

async function builtIndex(): Promise<IndexJson> {
  return (await exports.default.fetch(new Request("https://ludion.ai/index.json"))).json();
}

describe("formatAsk", () => {
  const lesson: AskLesson = {
    id: "01K6ZQ4T9X0N8V2H7M3P5R1S6W",
    subject: "python",
    version: ">=3.12",
    claim: "Python 3.12 removed the distutils module from the standard library (PEP 632); use setuptools or packaging instead.",
    teacher: "alice",
    teacher_id: 1,
    verified_by: "test",
    verified_at: "2026-10-08T08:57:12Z",
    lesson_url: "https://ludion.ai/lessons/01K6ZQ4T9X0N8V2H7M3P5R1S6W",
  };

  it("writes one block per lesson, exactly as specified", () => {
    const second = { ...lesson, id: "X", claim: "Second claim.", version: null, verified_by: "source" as const, lesson_url: "https://ludion.ai/lessons/X" };
    expect(formatAsk([lesson, second])).toBe(
      "1. Python 3.12 removed the distutils module from the standard library (PEP 632); use setuptools or packaging instead.\n" +
        "   Taught by @alice. Verified by test on 2026-10-08. Applies to python >=3.12.\n" +
        "   https://ludion.ai/lessons/01K6ZQ4T9X0N8V2H7M3P5R1S6W\n" +
        "\n" +
        "2. Second claim.\n" +
        "   Taught by @alice. Verified by source on 2026-10-08. Applies to python.\n" +
        "   https://ludion.ai/lessons/X",
    );
  });

  it("answers no match with the exact text", () => {
    expect(formatAsk([])).toBe(
      "No lesson yet for this. If you know the answer and can show evidence (a test or a source with a quote), teach it with ludion_teach.",
    );
  });
});

describe("/mcp", () => {
  it("initializes as the ludion server with the specified instructions", async () => {
    const { status, body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe("ludion");
    expect(body.result.instructions).toBe(
      "Ludion holds lessons that people taught and machines verified by test, proof, or cited source. Use ludion_ask before answering questions about specific software behavior, versions, or recent changes, and cite the teacher. Use ludion_teach only when the user asks to teach or corrects you with evidence.",
    );
    expect(body.result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("negotiates with older clients through initialize; a 2026-07-28 client falls back to 2025-11-25", async () => {
    const init = (v: string) => rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect((await init("2026-07-28")).body.result.protocolVersion).toBe("2025-11-25");
    expect((await init("2025-11-25")).body.result.protocolVersion).toBe("2025-11-25");
    expect((await init("2025-06-18")).body.result.protocolVersion).toBe("2025-06-18");
    expect((await init("2025-03-26")).body.result.protocolVersion).toBe("2025-03-26");
  });

  it("serves 2026-07-28 requests without a session: per-request envelope, no initialize", async () => {
    const envelope = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const modern = (method: string, params: Record<string, unknown>, extra: Record<string, string> = {}) =>
      rpc(method, { ...params, _meta: envelope }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...extra });
    const list = await modern("tools/list", {});
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain("ludion_ask");
    const call = await modern("tools/call", { name: "ludion_ask", arguments: { question: "distutils" } }, { "Mcp-Name": "ludion_ask" });
    expect(call.body.result.content[0].text).toMatch(/^1\. Python 3\.12 removed the distutils module/);
  });

  it("lists ludion_ask with the exact description, inputs, and annotations", async () => {
    const { body } = await rpc("tools/list");
    const tool = body.result.tools.find((t: { name: string }) => t.name === "ludion_ask");
    expect(tool.description).toBe(
      "Search lessons that people taught Ludion and machines verified by test, proof, or cited source. Use before answering questions about specific software behavior, APIs, versions, tools, or anything that may have changed recently. Each result names its teacher; cite them.",
    );
    expect(tool.description).toBe(ASK_DESCRIPTION);
    expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(tool.inputSchema.required).toEqual(["question"]);
    expect(tool.inputSchema.properties.question).toMatchObject({ type: "string", minLength: 1, maxLength: 8000 });
    expect(tool.inputSchema.properties.subject).toMatchObject({ type: "string" });
    expect(tool.inputSchema.properties.k).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
  });

  it("returns the example lesson for a distutils question, with its teacher, in text and structuredContent", async () => {
    const example = (await builtIndex()).lessons.find((l) => l.id === "01K6ZQ4T9X0N8V2H7M3P5R1S6W")!;
    const { body } = await ask({ question: "What changed about distutils in Python 3.12?" });
    const result = body.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.split("\n\n")[0]).toBe(
      `1. ${example.claim}\n` +
        `   Taught by @${example.teacher}. Verified by ${example.verified_by} on ${example.verified_at.slice(0, 10)}. Applies to python >=3.12.\n` +
        "   https://ludion.ai/lessons/01K6ZQ4T9X0N8V2H7M3P5R1S6W",
    );
    expect(result.structuredContent.lessons[0]).toEqual({
      id: example.id,
      subject: "python",
      version: ">=3.12",
      claim: example.claim,
      teacher: example.teacher,
      teacher_id: example.teacher_id,
      verified_by: "test",
      verified_at: example.verified_at,
      lesson_url: "https://ludion.ai/lessons/01K6ZQ4T9X0N8V2H7M3P5R1S6W",
    });
  });

  it("answers no match with the exact text and an empty list", async () => {
    const { body } = await ask({ question: "kubernetes ingress annotations" });
    expect(body.result.content[0].text).toBe(NO_MATCH);
    expect(body.result.structuredContent).toEqual({ lessons: [] });
  });

  it("filters by subject and honours k", async () => {
    expect((await ask({ question: "distutils", subject: "node" })).body.result.content[0].text).toBe(NO_MATCH);
    expect((await ask({ question: "distutils", k: 1 })).body.result.structuredContent.lessons.length).toBeLessThanOrEqual(1);
  });

  it("takes a question of up to 8,000 characters, such as a whole traceback", async () => {
    const question = `${"  File \"/srv/app/handler.py\", line 1, in <module>\n".repeat(150)}ModuleNotFoundError: No module named 'distutils'`.slice(-8000);
    const { body } = await ask({ question });
    expect(body.result.content[0].text).toContain("distutils");
  });

  it("refuses input outside the schema", async () => {
    for (const args of [{ question: "" }, { question: "x".repeat(8001) }, { question: "distutils", k: 11 }, { question: "distutils", k: 0 }, {}]) {
      const { body } = await ask(args);
      const failed = body.error !== undefined || body.result?.isError === true;
      expect(failed, JSON.stringify(args)).toBe(true);
    }
  });

  it("answers any origin, including a browser preflight", async () => {
    const preflight = await exports.default.fetch(
      new Request("https://ludion.ai/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://some-client.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      }),
    );
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const { status, res } = await rpc("tools/list", {}, { Origin: "https://some-client.example.com" });
    expect(status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("lessonsIndex", () => {
  function fakeAssets(builtAt: () => string, fail = () => false) {
    let calls = 0;
    const assets = {
      fetch: async () => {
        calls++;
        if (fail()) return new Response("down", { status: 500 });
        return Response.json({ version: 1, built_at: builtAt(), lessons: [], teachers: {} });
      },
    } as unknown as Fetcher;
    return { assets, calls: () => calls };
  }

  it("fetches at most once per 60 seconds and keeps the same object while built_at is unchanged", async () => {
    resetLessonsIndex();
    let built = "2026-10-08T00:00:00Z";
    const f = fakeAssets(() => built);
    const a = await lessonsIndex(f.assets, 0);
    const b = await lessonsIndex(f.assets, 59_000);
    expect(f.calls()).toBe(1);
    expect(b).toBe(a);
    const c = await lessonsIndex(f.assets, 61_000);
    expect(f.calls()).toBe(2);
    expect(c).toBe(a);
    built = "2026-10-08T01:00:00Z";
    const d = await lessonsIndex(f.assets, 122_000);
    expect(d).not.toBe(a);
    expect(d.built_at).toBe(built);
  });

  it("serves the last good index when revalidation fails", async () => {
    resetLessonsIndex();
    let down = false;
    const f = fakeAssets(() => "2026-10-08T00:00:00Z", () => down);
    const a = await lessonsIndex(f.assets, 0);
    down = true;
    expect(await lessonsIndex(f.assets, 61_000)).toBe(a);
    resetLessonsIndex();
    await expect(lessonsIndex(f.assets, 0)).rejects.toThrow(/HTTP 500/);
  });
});
