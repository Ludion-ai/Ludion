import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatLesson, type FetchFn, type Lesson } from "@ludion/core";
import { dockerArgs, interpretRun, type RunFn } from "../src/docker.ts";
import { collectLessonFiles } from "../src/files.ts";
import { summaryLine, verifyLesson, type VerifyContext } from "../src/verify.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLE_PATH = "lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json";
const exampleText = readFileSync(`${ROOT}/${EXAMPLE_PATH}`, "utf8");
const example = JSON.parse(exampleText) as Lesson;

const pageWith = (text: string): FetchFn => async () => new Response(`<p>${text}</p>`, { headers: { "content-type": "text/html" } });
const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  base: [example],
  fetchFn: pageWith("Code that imports distutils will no longer work from Python 3.12."),
  ...over,
});
const fileOf = (l: Lesson, path = `lessons/${l.subject}/${l.id}.json`) => ({ path, text: formatLesson(l) });
const sourceOnly = (over: Partial<Lesson> = {}): Lesson => ({
  ...example,
  id: "01K70000000000000000000001",
  evidence: [{ source: { url: "https://example.com/", quote: "a sentence on the page" } }],
  ...over,
});

describe("verifyLesson", () => {
  it("passes the example", async () => {
    const r = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx());
    expect(r).toMatchObject({ status: "passed", id: example.id, reasons: [], labels: [] });
  });

  it("finds the example's quote in PEP 632 as published; the original quote is not there", async () => {
    // Excerpt of https://peps.python.org/pep-0632/ as served on 2026-10-07 (title and Backwards Compatibility section).
    const pep632 = [
      "<title>PEP 632 – Deprecate distutils module | peps.python.org</title>",
      '<h2><a class="toc-backref" href="#backwards-compatibility" role="doc-backlink">Backwards Compatibility</a></h2>',
      "<p>Code that imports distutils will no longer work from Python 3.12.</p>",
    ].join("\n");
    const fetchFn: FetchFn = async () => new Response(pep632, { headers: { "content-type": "text/html; charset=utf-8" } });
    const r = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ fetchFn }));
    expect(r.status).toBe("passed");

    const original = { ...example, evidence: [example.evidence[0]!, { source: { url: "https://peps.python.org/pep-0632/", quote: "Remove distutils from the standard library" } }] };
    const old = await verifyLesson({ path: EXAMPLE_PATH, text: formatLesson(original) }, ctx({ fetchFn }));
    expect(old.status).toBe("failed");
  });

  it("fails invalid JSON with a fix-it message", async () => {
    const r = await verifyLesson({ path: "lessons/python/x.json", text: "{" }, ctx());
    expect(r.status).toBe("failed");
    expect(r.reasons[0]).toMatch(/^This file is not valid JSON .*Fix the syntax\.$/);
  });

  it("fails schema errors field by field", async () => {
    const { author_id: _, ...noId } = example;
    const r = await verifyLesson({ path: EXAMPLE_PATH, text: JSON.stringify(noId, null, 2) + "\n" }, ctx());
    expect(r.status).toBe("failed");
    expect(r.reasons).toEqual([expect.stringMatching(/^\/author_id: .*numeric GitHub user id/)]);
  });

  it("fails a file that is not canonical, naming the line", async () => {
    const r = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText.replace(/\n/g, "\r\n") }, ctx());
    expect(r.status).toBe("failed");
    expect(r.reasons[0]).toMatch(/not in canonical form: line 1/);
    const compact = await verifyLesson({ path: EXAMPLE_PATH, text: JSON.stringify(example) + "\n" }, ctx());
    expect(compact.reasons[0]).toMatch(/not in canonical form/);
  });

  it("fails a file at the wrong path", async () => {
    const r = await verifyLesson({ path: `lessons/node/${example.id}.json`, text: exampleText }, ctx());
    expect(r.status).toBe("failed");
    expect(r.reasons).toEqual([`The file must be at ${EXAMPLE_PATH} (subject and id decide the path), not lessons/node/${example.id}.json.`]);
  });

  it("accepts replaces that name an active lesson, rejects others", async () => {
    const good = sourceOnly({ replaces: [example.id] });
    const page = pageWith("a sentence on the page");
    expect((await verifyLesson(fileOf(good), ctx({ fetchFn: page }))).status).toBe("passed");

    const unknown = sourceOnly({ replaces: ["01K7ZZZZZZZZZZZZZZZZZZZZZZ"] });
    const r = await verifyLesson(fileOf(unknown), ctx({ fetchFn: page }));
    expect(r.status).toBe("failed");
    expect(r.reasons[0]).toMatch(/not an active lesson on main/);
  });

  it("rejects replacing a lesson that something else already replaced", async () => {
    const earlier = sourceOnly({ id: "01K70000000000000000000002", replaces: [example.id] });
    const late = sourceOnly({ replaces: [example.id] });
    const r = await verifyLesson(fileOf(late), ctx({ base: [example, earlier, late], fetchFn: pageWith("a sentence on the page") }));
    expect(r.status).toBe("failed");
  });

  it("reports a missing source quote", async () => {
    const r = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ fetchFn: pageWith("nothing here") }));
    expect(r.status).toBe("failed");
    expect(r.reasons).toEqual(["evidence 2 (source): That quote isn't on peps.python.org. Copy a sentence exactly as it appears on the page."]);
  });

  it("does not run test code unless asked", async () => {
    let calls = 0;
    const run: RunFn = async () => (calls++, { status: "passed" });
    await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx());
    expect(calls).toBe(0);
    await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ run }));
    expect(calls).toBe(1);
  });

  it("fails when the test fails, and skips with a label when it prints skip:", async () => {
    const failing: RunFn = async () => ({ status: "failed", reason: "The test exited with code 1, so the claim did not hold." });
    const f = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ run: failing }));
    expect(f.status).toBe("failed");
    expect(f.reasons).toEqual(["evidence 1 (python): The test exited with code 1, so the claim did not hold."]);

    const skipping: RunFn = async () => ({ status: "skipped", reason: "skip: runner is older than 3.12" });
    const s = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ run: skipping }));
    expect(s).toMatchObject({ status: "skipped", labels: ["skipped"] });
  });

  it("labels lean evidence needs-lean without running it", async () => {
    const lean = sourceOnly({ evidence: [{ run: { runner: "lean", code: "theorem t : 1 = 1 := rfl" } }] });
    const r = await verifyLesson(fileOf(lean), ctx({ run: async () => { throw new Error("must not run"); } }));
    expect(r).toMatchObject({ status: "skipped", labels: ["needs-lean"] });
  });
});

describe("docker", () => {
  it("isolates the run exactly as ci.md says", () => {
    expect(dockerArgs("python", "n")).toEqual([
      "run", "--rm", "-i", "--name", "n",
      "--network", "none", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--read-only", "--tmpfs", "/tmp",
      "python:3.14-slim", "python", "-",
    ]);
    expect(dockerArgs("bash", "n").slice(-3)).toEqual(["python:3.14-slim", "bash", "-s"]);
    expect(dockerArgs("node", "n").slice(-3)).toEqual(["node:24-slim", "node", "-"]);
  });

  it("interprets exit codes, skip lines, and timeouts", () => {
    expect(interpretRun(0, "ok\n", "", false)).toEqual({ status: "passed" });
    expect(interpretRun(0, "note\nskip: too old\n", "", false)).toEqual({ status: "skipped", reason: "skip: too old" });
    expect(interpretRun(1, "", "AssertionError: distutils still importable", false)).toEqual({
      status: "failed",
      reason: "The test exited with code 1, so the claim did not hold.\nAssertionError: distutils still importable",
    });
    expect(interpretRun(null, "", "", true).status).toBe("failed");
    expect(interpretRun(3, "skip: not a pass", "", false).status).toBe("failed");
  });
});

describe("cli helpers", () => {
  it("prints status, id, and the first 60 characters of the claim", () => {
    const line = summaryLine({ file: "f", id: example.id, claim: example.claim, status: "passed", reasons: [], labels: [] });
    expect(line).toBe(`passed   ${example.id}  ${example.claim.slice(0, 60)}`);
  });

  it("collects lesson files from a directory, skipping the schema", () => {
    expect(collectLessonFiles(["lessons/"], ROOT).map((f) => f.path)).toEqual([EXAMPLE_PATH]);
  });

  it("explains a path that does not exist", () => {
    expect(() => collectLessonFiles(["nope/"], ROOT)).toThrow(/nope\/ does not exist/);
  });
});
