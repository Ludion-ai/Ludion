import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateLesson } from "../src/index.ts";
import { generateValidatorSource } from "../scripts/validator-source.ts";
import { example, lesson, SCHEMA_PATH } from "./helpers.ts";

describe("validateLesson", () => {
  it("accepts the example lesson", () => {
    expect(validateLesson(example())).toEqual({ ok: true, lesson: example() });
  });

  it("requires author_id", () => {
    const { author_id: _, ...rest } = lesson();
    const r = validateLesson(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ path: "/author_id", message: expect.stringContaining("numeric GitHub user id") });
  });

  it.each([0, -3, 1.5, "1001"])("rejects author_id %j", (author_id) => {
    const r = validateLesson({ ...lesson(), author_id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(["/author_id"]);
  });

  it("explains a short claim in plain words", () => {
    const r = validateLesson(lesson({ claim: "Too short" }));
    expect(r).toEqual({ ok: false, errors: [{ path: "/claim", message: "Write one sentence of 10 to 400 characters." }] });
  });

  it("counts claim length in characters, not UTF-16 units", () => {
    expect(validateLesson(lesson({ claim: "😀".repeat(400) })).ok).toBe(true);
    expect(validateLesson(lesson({ claim: "😀".repeat(401) })).ok).toBe(false);
  });

  it("reports only the errors of the evidence kind that was meant", () => {
    const r = validateLesson(lesson({ evidence: [{ source: { url: "http://example.com/", quote: "something true" } }] }));
    expect(r).toEqual({ ok: false, errors: [{ path: "/evidence/0/source/url", message: "The source URL must start with https://." }] });
  });

  it("explains evidence of no known kind", () => {
    const r = validateLesson({ ...lesson(), evidence: [{ proof: "trust me" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([{ path: "/evidence/0", message: expect.stringContaining("Each piece of evidence is either a test") }]);
  });

  it("rejects unknown fields by name", () => {
    const r = validateLesson({ ...lesson(), teacher: "alice" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([{ path: "/teacher", message: 'Remove the field "teacher"; lessons do not have it.' }]);
  });

  it("rejects a lowercase or wrong-length id", () => {
    expect(validateLesson(lesson({ id: "01k6zq4t9x0n8v2h7m3p5r1s6w" })).ok).toBe(false);
    expect(validateLesson(lesson({ id: "01K6ZQ4T9X0N8V2H7M3P5R1S6" })).ok).toBe(false);
  });
});

describe("generated validator", () => {
  it("is up to date with lessons.schema.json (run npm run gen:validator if this fails)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../src/generated/validate-lesson.js", import.meta.url)), "utf8");
    expect(committed).toBe(generateValidatorSource(readFileSync(SCHEMA_PATH, "utf8")));
  });

  it("has no imports, so it runs in the Worker and the browser", () => {
    const committed = readFileSync(fileURLToPath(new URL("../src/generated/validate-lesson.js", import.meta.url)), "utf8");
    expect(committed).not.toMatch(/\brequire\(|^\s*import\s/m);
  });
});
