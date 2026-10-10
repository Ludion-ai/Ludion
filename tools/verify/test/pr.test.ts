import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatLesson, validateLesson, type FetchFn, type LessonV1 } from "@ludion/core";
import { compileLessonSchema } from "../src/base-schema.ts";
import { authorProblem, IMMUTABLE, LESSON_FILES_ONLY, parseNameStatus, planChanges, STRAY_FILE, verifyPullRequest, type PullRequestContext } from "../src/pr.ts";
import { labelsOf, stepSummary } from "../src/report.ts";

const lesson: LessonV1 = {
  format: 1,
  id: "01K70000000000000000000001",
  subject: "python",
  package: { ecosystem: "runtime", name: "python" },
  versions: ">=3.0",
  kind: "behavior",
  symbol: "int.__add__",
  signal: "loud",
  evidence: [{ test: { runtime: "python@3.12", code: "assert 1 + 1 == 2" } }],
  author: "github:Alice",
  author_id: 1001,
  created_at: "2026-10-07T00:00:00Z",
};
const path = `lessons/python/${lesson.id}.json`;
const SCHEMA_PATH = fileURLToPath(new URL("../../../lessons/lessons.schema.json", import.meta.url));
const alice = { id: 1001, login: "alice", type: "User" };
const app = { id: 9, login: "ludion[bot]", type: "Bot" };

describe("planChanges", () => {
  it("sorts added and deleted lessons and refuses edits", () => {
    const plan = planChanges(
      parseNameStatus([`A\t${path}`, "D\tlessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json", "M\tlessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6X.json", ""].join("\n")),
    );
    expect(plan).toEqual({
      added: [path],
      deleted: ["lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json"],
      problems: [{ path: "lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6X.json", reason: IMMUTABLE }],
    });
  });

  it("refuses a lesson PR that also changes the schema, config, or code", () => {
    const plan = planChanges(
      parseNameStatus([`A\t${path}`, "M\tlessons/lessons.schema.json", "M\tludion.config.json", "M\ttools/verify/src/pr.ts", "A\tlessons/README.md"].join("\n")),
    );
    expect(plan.added).toEqual([path]);
    expect(plan.problems).toEqual([
      { path: "lessons/lessons.schema.json", reason: LESSON_FILES_ONLY },
      { path: "ludion.config.json", reason: LESSON_FILES_ONLY },
      { path: "tools/verify/src/pr.ts", reason: LESSON_FILES_ONLY },
      { path: "lessons/README.md", reason: LESSON_FILES_ONLY },
    ]);
  });

  it("leaves a code PR alone, schema changes included, but refuses stray files in lessons/", () => {
    expect(planChanges(parseNameStatus("M\tlessons/lessons.schema.json\nM\tpackages/core/src/schema.ts"))).toEqual({ added: [], deleted: [], problems: [] });
    expect(planChanges(parseNameStatus("A\tlessons/README.md")).problems).toEqual([{ path: "lessons/README.md", reason: STRAY_FILE }]);
  });
});

describe("compileLessonSchema (the base branch's schema)", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

  it("validates like the precompiled schema", () => {
    const validate = compileLessonSchema(JSON.stringify(schema));
    expect(validate(lesson)).toEqual({ ok: true, lesson });
    const { author_id: _, ...noId } = lesson;
    expect(validate(noId)).toEqual(validateLesson(noId));
  });

  it("is what a lesson is checked against, so a looser schema in the PR does not help", async () => {
    // The PR's copy would allow a missing author_id; the base schema still refuses it.
    const { author_id: _, ...noId } = lesson;
    const text = JSON.stringify(noId, null, 2) + "\n";
    const results = await verifyPullRequest(
      { added: [path], deleted: [], problems: [] },
      [{ path, text }],
      { base: [], fetchFn: async () => new Response(""), author: alice, validate: compileLessonSchema(JSON.stringify(schema)) },
    );
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.reasons[0]).toMatch(/^\/author_id:/);
  });
});

describe("authorProblem", () => {
  it("accepts a person's own lesson, by id, whatever the login's case", () => {
    expect(authorProblem(lesson, alice)).toBeUndefined();
  });

  it("refuses a lesson whose author_id is someone else's", () => {
    const mallory = { id: 666, login: "Alice", type: "User" };
    expect(authorProblem(lesson, mallory)).toMatch(/author_id is 1001, but the pull request was opened by @Alice \(666\)/);
  });

  it("refuses every bot: lessons come from the teacher's own account", () => {
    expect(authorProblem(lesson, app)).toMatch(/a bot\. Lessons come from the teacher's own GitHub account/);
    expect(authorProblem(lesson, { id: 1001, login: "alice[bot]", type: "Bot" })).toMatch(/a bot/);
  });
});

describe("verifyPullRequest", () => {
  const fetchFn: FetchFn = async () => new Response("", { headers: { "content-type": "text/html" } });
  const ctx = (over: Partial<PullRequestContext> = {}): PullRequestContext => ({
    base: [],
    fetchFn,
    run: async () => ({ kind: "done" as const, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    author: alice,
    ...over,
  });

  it("passes a person's lesson whose test passes", async () => {
    const results = await verifyPullRequest({ added: [path], deleted: [], problems: [] }, [{ path, text: formatLesson(lesson) }], ctx());
    expect(results).toMatchObject([{ status: "passed", id: lesson.id }]);
  });

  it("fails a lesson whose test fails", async () => {
    const run = async () => ({ kind: "done" as const, exitCode: 1, stdout: "", stderr: "", timedOut: false });
    const results = await verifyPullRequest({ added: [path], deleted: [], problems: [] }, [{ path, text: formatLesson(lesson) }], ctx({ run }));
    expect(results[0]).toMatchObject({ status: "failed", reasons: ["evidence 1 (python@3.12): The test exited with code 1, so the fact did not hold."] });
  });

  it("fails a lesson opened by someone who is not its author", async () => {
    const results = await verifyPullRequest({ added: [path], deleted: [], problems: [] }, [{ path, text: formatLesson(lesson) }], ctx({ author: { id: 7, login: "eve", type: "User" } }));
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.reasons.at(-1)).toMatch(/Teach lessons in your own name/);
  });

  it("labels a retraction and reports problems as failures", async () => {
    const results = await verifyPullRequest(
      { added: [], deleted: ["lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json"], problems: [{ path: "lessons/x/y.json", reason: IMMUTABLE }] },
      [],
      ctx(),
    );
    expect(results).toMatchObject([
      { status: "failed", reasons: [IMMUTABLE] },
      { status: "passed", id: "01K6ZQ4T9X0N8V2H7M3P5R1S6W", labels: ["retract"] },
    ]);
    expect(labelsOf(results)).toEqual(["retract"]);
    expect(stepSummary(results)).toContain("| passed | `01K6ZQ4T9X0N8V2H7M3P5R1S6W` |  | retracted |");
  });
});
