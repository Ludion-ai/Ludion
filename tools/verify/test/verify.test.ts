import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatLesson, type FetchFn, type LessonV0, type LessonV1 } from "@ludion/core";
import { dockerArgs, imageFor, installArgs, interpretRun, type RunFn, type RunSpec } from "../src/docker.ts";
import { compileLessonSchema } from "../src/base-schema.ts";
import { collectLessonFiles } from "../src/files.ts";
import { summaryLine, verifyLesson, type VerifyContext } from "../src/verify.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLE_PATH = "lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json";
const exampleText = readFileSync(`${ROOT}/${EXAMPLE_PATH}`, "utf8");
const example = JSON.parse(exampleText) as LessonV0;
const done = (exitCode: number | null, stdout = "", stderr = "", timedOut = false) => ({ kind: "done" as const, exitCode, stdout, stderr, timedOut });

const pageWith = (text: string): FetchFn => async () => new Response(`<p>${text}</p>`, { headers: { "content-type": "text/html" } });
const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  base: [example],
  fetchFn: pageWith("Code that imports distutils will no longer work from Python 3.12."),
  ...over,
});
const fileOf = (l: LessonV0, path = `lessons/${l.subject}/${l.id}.json`) => ({ path, text: formatLesson(l) });
const sourceOnly = (over: Partial<LessonV0> = {}): LessonV0 => ({
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
    const run: RunFn = async () => (calls++, done(0));
    await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx());
    expect(calls).toBe(0);
    await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ run }));
    expect(calls).toBe(1);
  });

  it("fails when the test fails, and skips with a label when it prints skip:", async () => {
    const failing: RunFn = async () => done(1);
    const f = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ run: failing }));
    expect(f.status).toBe("failed");
    expect(f.reasons).toEqual(["evidence 1 (python): The test exited with code 1, so the fact did not hold."]);

    const skipping: RunFn = async () => done(0, "skip: runner is older than 3.12\n");
    const s = await verifyLesson({ path: EXAMPLE_PATH, text: exampleText }, ctx({ run: skipping }));
    expect(s).toMatchObject({ status: "skipped", labels: ["skipped"] });
  });

  it("labels lean evidence needs-lean without running it", async () => {
    const lean = sourceOnly({ evidence: [{ run: { runner: "lean", code: "theorem t : 1 = 1 := rfl" } }] });
    const r = await verifyLesson(fileOf(lean), ctx({ run: async () => { throw new Error("must not run"); } }));
    expect(r).toMatchObject({ status: "skipped", labels: ["needs-lean"] });
  });
});

describe("verifyLesson, format 1", () => {
  const QUOTE = "toHaveTextContent is strict, add toMatchTextContent as alternative";
  const v1 = (over: Partial<LessonV1> = {}): LessonV1 => ({
    format: 1,
    id: "01K7Z000000000000000000001",
    subject: "vitest",
    package: { ecosystem: "npm", name: "vitest" },
    versions: ">=5.0.0",
    kind: "behavior",
    symbol: "toHaveTextContent",
    replacement: "toMatchTextContent",
    signal: "loud",
    detail: "toHaveTextContent is strict",
    evidence: [{ source: { url: "https://example.com/v5", quote: QUOTE } }],
    author: "github:alice",
    author_id: 1001,
    created_at: "2026-10-11T00:00:00Z",
    ...over,
  });
  const file = (l: LessonV1) => ({ path: `lessons/${l.subject}/${l.id}.json`, text: formatLesson(l) });
  const c = (over: Partial<VerifyContext> = {}) => ctx({ fetchFn: pageWith(QUOTE), ...over });

  it("passes a grounded lesson whose quote names the symbol, and reports its generated claim", async () => {
    const r = await verifyLesson(file(v1()), c());
    expect(r).toMatchObject({ status: "passed", reasons: [] });
    expect(r.claim).toBe("vitest >=5.0.0 changed what `toHaveTextContent` does. ToHaveTextContent is strict.");
  });

  it("fails a detail with words the evidence doesn't contain", async () => {
    const r = await verifyLesson(file(v1({ detail: "toHaveTextContent is dangerous now" })), c());
    expect(r.status).toBe("failed");
    expect(r.reasons).toEqual([expect.stringContaining("The detail uses words the evidence doesn't contain: dangerou")]);
  });

  it("fails a quote that doesn't name the symbol, and a subject that doesn't match the package", async () => {
    const headline = "Breaking changes to the text matchers in browser mode";
    const q = await verifyLesson(file(v1({ evidence: [{ source: { url: "https://example.com/v5", quote: headline } }] })), ctx({ fetchFn: pageWith(headline) }));
    expect(q.reasons).toContainEqual(expect.stringContaining("doesn't name toHaveTextContent"));
    const s = await verifyLesson(file(v1({ subject: "vite" })), c());
    expect(s.reasons).toContainEqual("The subject for package vitest is vitest, not vite.");
  });

  it("runs pinned tests with their packages, and checks an expected failure's error", async () => {
    const specs: RunSpec[] = [];
    const run: RunFn = async (spec) => {
      specs.push(spec);
      return spec.packages?.vitest === "4.1.11"
        ? { kind: "done", exitCode: 1, stdout: "", stderr: "AssertionError: expected strict match", timedOut: false }
        : { kind: "done", exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const pair = v1({
      detail: undefined,
      evidence: [
        { test: { runtime: "node@24", packages: { vitest: "5.0.3" }, code: "new()" } },
        { test: { runtime: "node@24", packages: { vitest: "4.1.11" }, code: "old()", expect: "fail", error: "expected strict match" } },
      ],
    });
    expect(await verifyLesson(file(pair), c({ run }))).toMatchObject({ status: "passed" });
    expect(specs).toEqual([
      { runtime: "node@24", code: "new()", packages: { vitest: "5.0.3" } },
      { runtime: "node@24", code: "old()", packages: { vitest: "4.1.11" } },
    ]);
    const wrongError = v1({ detail: undefined, evidence: [{ test: { runtime: "node@24", packages: { vitest: "4.1.11" }, code: "old()", expect: "fail", error: "a different message" } }] });
    const r = await verifyLesson(file(wrongError), c({ run }));
    expect(r.reasons).toEqual([expect.stringContaining('evidence 1 (node@24 vitest@4.1.11): The test failed, but its output does not contain "a different message"')]);
  });

  it("refuses a new format 0 lesson when checked against the base branch's format 1 schema", async () => {
    const schema = readFileSync(`${ROOT}/lessons/lessons.schema.json`, "utf8");
    const r = await verifyLesson(fileOf(sourceOnly()), ctx({ validate: compileLessonSchema(schema) }));
    expect(r.status).toBe("failed");
    expect(r.reasons).toContainEqual(expect.stringMatching(/^\/format: New lessons are format 1/));
  });
});

describe("docker", () => {
  it("isolates the run as docs/decisions.md says: network off, read-only, limits", () => {
    expect(dockerArgs("python", "n")).toEqual([
      "run", "--rm", "-i", "--name", "n",
      "--network", "none", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--read-only", "--tmpfs", "/tmp",
      "python:3.14-slim", "python", "-",
    ]);
    expect(dockerArgs("bash", "n").slice(-3)).toEqual(["python:3.14-slim", "bash", "-s"]);
    expect(dockerArgs("node", "n").slice(-3)).toEqual(["node:24-slim", "node", "-"]);
  });

  it("interprets exit codes, skip lines, and timeouts", () => {
    expect(interpretRun(done(0, "ok\n"))).toEqual({ status: "passed" });
    expect(interpretRun(done(0, "note\nskip: too old\n"))).toEqual({ status: "skipped", reason: "skip: too old" });
    expect(interpretRun(done(1, "", "AssertionError: distutils still importable"))).toEqual({
      status: "failed",
      reason: "The test exited with code 1, so the fact did not hold.\nAssertionError: distutils still importable",
    });
    expect(interpretRun(done(null, "", "", true)).status).toBe("failed");
    expect(interpretRun(done(3, "skip: not a pass")).status).toBe("failed");
    expect(interpretRun({ kind: "error", reason: "Could not start Docker." })).toEqual({ status: "failed", reason: "Could not start Docker." });
  });
});

describe("docker, format 1", () => {
  it("maps runtimes to images", () => {
    expect(imageFor("node@22")).toEqual({ image: "node:22-slim", command: ["node", "-"], language: "node" });
    expect(imageFor("python@3.12")).toEqual({ image: "python:3.12-slim", command: ["python", "-"], language: "python" });
    expect(imageFor("ruby@3")).toBeUndefined();
  });

  it("runs lesson code with the network off, even when packages are mounted", () => {
    const args = dockerArgs("node@24", "n", "/tmp/w");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only");
    expect(args.slice(args.indexOf("-v"), args.indexOf("-v") + 2)).toEqual(["-v", "/tmp/w:/w"]);
    expect(args.slice(-3)).toEqual(["node:24-slim", "node", "-"]);
  });

  it("installs packages with the network on but install scripts off, and never runs lesson code there", () => {
    const npm = installArgs("node@24", "/tmp/w", { vitest: "5.0.3" });
    expect(npm).not.toContain("--network");
    expect(npm).toContain("--ignore-scripts");
    expect(npm).not.toContain("-i");
    const pip = installArgs("python@3.12", "/tmp/w", { requests: "2.32.0" });
    // Wheels only: no package build scripts run at install time either.
    expect(pip.slice(-5)).toEqual(["--only-binary", ":all:", "--target", "/w/site", "requests==2.32.0"]);
    expect(pip).not.toContain("--network");
  });

  it("checks an expected failure: non-zero exit with the named error passes; exit 0 or another error fails", () => {
    const run = (exitCode: number, stderr: string) => ({ kind: "done" as const, exitCode, stdout: "", stderr, timedOut: false });
    expect(interpretRun(run(1, "Error: expected strict match"), "fail", "expected strict match")).toEqual({ status: "passed" });
    expect(interpretRun(run(0, ""), "fail", "expected strict match").status).toBe("failed");
    expect(interpretRun(run(1, "SyntaxError"), "fail", "expected strict match").status).toBe("failed");
  });
});

describe("cli helpers", () => {
  it("prints status, id, and the first 60 characters of the claim", () => {
    const line = summaryLine({ file: "f", id: example.id, claim: example.claim, status: "passed", reasons: [], labels: [] });
    expect(line).toBe(`passed   ${example.id}  ${example.claim.slice(0, 60)}`);
  });

  it("collects lesson files from a directory, skipping the schema", () => {
    // Its own tree, so the test does not depend on which lessons are in the repo.
    const root = mkdtempSync(join(tmpdir(), "ludion-verify-"));
    try {
      mkdirSync(join(root, "lessons", "python"), { recursive: true });
      mkdirSync(join(root, "lessons", "node"), { recursive: true });
      writeFileSync(join(root, "lessons", "lessons.schema.json"), "{}");
      writeFileSync(join(root, "lessons", "python", "B.json"), "{}");
      writeFileSync(join(root, "lessons", "node", "A.json"), "{}");
      writeFileSync(join(root, "lessons", "node", "notes.txt"), "");
      expect(collectLessonFiles(["lessons/"], root).map((f) => f.path)).toEqual(["lessons/node/A.json", "lessons/python/B.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains a path that does not exist", () => {
    expect(() => collectLessonFiles(["nope/"], ROOT)).toThrow(/nope\/ does not exist/);
  });
});
