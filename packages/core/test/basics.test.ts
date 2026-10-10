import { describe, expect, it } from "vitest";
import { activeSet, formatLesson, newId, validateLesson, verifiedBy } from "../src/index.ts";
import { example, exampleText, lesson } from "./helpers.ts";

describe("formatLesson", () => {
  it("round-trips the example byte for byte", () => {
    expect(formatLesson(example())).toBe(exampleText());
  });

  it("puts keys in spec order and omits absent optional fields", () => {
    const l = lesson({ version: null, replaces: ["01K6ZQ4T9X0N8V2H7M3P5R1S6W"] });
    const shuffled = Object.fromEntries(Object.entries(l).reverse()) as typeof l;
    const keys = Object.keys(JSON.parse(formatLesson(shuffled)));
    expect(keys).toEqual(["id", "subject", "claim", "evidence", "author", "author_id", "replaces", "created_at"]);
  });

  it("orders keys inside evidence too", () => {
    const l = lesson({ evidence: [{ run: { code: "exit 0", runner: "bash" } } as never] });
    expect(formatLesson(l)).toContain('"runner": "bash",\n        "code": "exit 0"');
  });

  it("ends with exactly one newline and uses 2-space indent", () => {
    const text = formatLesson(lesson());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toMatch(/^\{\n {2}"id"/);
  });
});

describe("newId", () => {
  it("makes a valid ULID whose time part sorts with time", () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(validateLesson(lesson({ id: a })).ok).toBe(true);
  });

  it("encodes the time in the first 10 characters", () => {
    expect(newId(0).slice(0, 10)).toBe("0000000000");
    expect(newId(2 ** 48 - 1).slice(0, 10)).toBe("7ZZZZZZZZZ");
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId(1)));
    expect(ids.size).toBe(1000);
  });

  it("refuses times it cannot encode", () => {
    expect(() => newId(-1)).toThrow(/millisecond timestamp/);
    expect(() => newId(2 ** 48)).toThrow(RangeError);
  });
});

describe("activeSet", () => {
  it("drops a replaced lesson", () => {
    const old = lesson();
    const fix = lesson({ replaces: [old.id] });
    const other = lesson();
    expect(activeSet([old, fix, other])).toEqual([fix, other]);
  });

  it("keeps everything when nothing is replaced", () => {
    const ls = [lesson(), lesson()];
    expect(activeSet(ls)).toEqual(ls);
  });

  it("ignores a lesson that lists itself", () => {
    const self = lesson();
    self.replaces = [self.id];
    expect(activeSet([self])).toEqual([self]);
  });
});

describe("verifiedBy", () => {
  const run = (runner: "python" | "lean") => ({ run: { runner, code: "x" } });
  const source = { source: { url: "https://example.com/", quote: "something" } };
  it("labels lean as proof, other runs as test, else source", () => {
    expect(verifiedBy(lesson({ evidence: [run("python"), run("lean")] }))).toBe("proof");
    expect(verifiedBy(lesson({ evidence: [source, run("python")] }))).toBe("test");
    expect(verifiedBy(lesson({ evidence: [source] }))).toBe("source");
    expect(verifiedBy(example())).toBe("test");
  });
});
