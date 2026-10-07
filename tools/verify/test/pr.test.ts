import { describe, expect, it } from "vitest";
import { formatLesson, type FetchFn, type Lesson } from "@ludion/core";
import { authorProblem, IMMUTABLE, parseNameStatus, planChanges, verifyPullRequest, type PullRequestContext } from "../src/pr.ts";
import { labelsOf, stepSummary } from "../src/report.ts";

const lesson: Lesson = {
  id: "01K70000000000000000000001",
  subject: "ludion-selftest",
  claim: "One plus one equals two in Python.",
  evidence: [{ run: { runner: "python", code: "assert 1 + 1 == 2" } }],
  author: "github:Alice",
  author_id: 1001,
  created_at: "2026-10-07T00:00:00Z",
};
const path = `lessons/ludion-selftest/${lesson.id}.json`;
const alice = { id: 1001, login: "alice", type: "User" };
const app = { id: 9, login: "ludion[bot]", type: "Bot" };

describe("planChanges", () => {
  it("sorts added and deleted lessons, refuses edits and stray files, ignores the schema", () => {
    const plan = planChanges(
      parseNameStatus(
        [`A\t${path}`, "D\tlessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json", "M\tlessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6X.json", "M\tlessons/lessons.schema.json", "A\tlessons/README.md", ""].join("\n"),
      ),
    );
    expect(plan).toEqual({
      added: [path],
      deleted: ["lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json"],
      problems: [
        { path: "lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6X.json", reason: IMMUTABLE },
        { path: "lessons/README.md", reason: "Only lesson files go in lessons/<subject>/." },
      ],
    });
  });
});

describe("authorProblem", () => {
  it("accepts a person's own lesson, by id, whatever the login's case", () => {
    expect(authorProblem(lesson, alice, undefined, null)).toBeUndefined();
  });

  it("refuses a lesson in someone else's name, even with a matching login", () => {
    const mallory = { id: 666, login: "Alice", type: "User" };
    expect(authorProblem(lesson, mallory, undefined, null)).toMatch(/author_id is 1001, but the pull request was opened by @Alice \(666\)/);
  });

  it("accepts the App when the trailer matches id and login (case-insensitive)", () => {
    expect(authorProblem(lesson, app, "ludion[bot]", "Teach x: y\n\nTaught-by: alice (1001)\n")).toBeUndefined();
  });

  it("refuses the App when the trailer is missing or names someone else", () => {
    expect(authorProblem(lesson, app, "ludion[bot]", "Teach x: y\n")).toMatch(/no "Taught-by/);
    expect(authorProblem(lesson, app, "ludion[bot]", "Taught-by: alice (1002)")).toMatch(/must match/);
    expect(authorProblem(lesson, app, "ludion[bot]", "Taught-by: bob (1001)")).toMatch(/must match/);
    expect(authorProblem(lesson, app, "ludion[bot]", "Taught-by: alice")).toMatch(/no "Taught-by/);
  });

  it("refuses any other bot, and every bot while no App is configured", () => {
    expect(authorProblem(lesson, { id: 5, login: "dependabot[bot]", type: "Bot" }, "ludion[bot]", "Taught-by: alice (1001)")).toMatch(/not the Ludion App/);
    expect(authorProblem(lesson, app, undefined, "Taught-by: alice (1001)")).toMatch(/not the Ludion App/);
  });
});

describe("verifyPullRequest", () => {
  const fetchFn: FetchFn = async () => new Response("", { headers: { "content-type": "text/html" } });
  const ctx = (over: Partial<PullRequestContext> = {}): PullRequestContext => ({
    base: [],
    fetchFn,
    run: async () => ({ status: "passed" }),
    author: alice,
    commitMessageFor: () => null,
    ...over,
  });

  it("passes a person's lesson whose test passes", async () => {
    const results = await verifyPullRequest({ added: [path], deleted: [], problems: [] }, [{ path, text: formatLesson(lesson) }], ctx());
    expect(results).toMatchObject([{ status: "passed", id: lesson.id }]);
  });

  it("fails a lesson whose test fails", async () => {
    const run = async () => ({ status: "failed" as const, reason: "The test exited with code 1, so the claim did not hold." });
    const results = await verifyPullRequest({ added: [path], deleted: [], problems: [] }, [{ path, text: formatLesson(lesson) }], ctx({ run }));
    expect(results[0]).toMatchObject({ status: "failed", reasons: ["evidence 1 (python): The test exited with code 1, so the claim did not hold."] });
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
