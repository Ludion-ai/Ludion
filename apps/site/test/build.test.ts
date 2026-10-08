import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAddedLog } from "../src/build/git-info.ts";
import { teacherPages } from "../src/build/teacher-pages.ts";

const R = "\x1e";
const F = "\x1f";

describe("parseAddedLog", () => {
  it("takes verified_at and the PR number from the commit that added each lesson", () => {
    const log = [
      `${R}2026-10-09T10:00:00+09:00${F}Teach node: something (#42)`,
      "",
      "lessons/node/01K70000000000000000000002.json",
      `${R}2026-10-07T11:40:25Z${F}Add v0 spec`,
      "",
      "lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json",
      "lessons/lessons.schema.json",
      "",
    ].join("\n");
    expect(parseAddedLog(log)).toEqual({
      "01K70000000000000000000002": { verified_at: "2026-10-09T01:00:00Z", pr: 42 },
      "01K6ZQ4T9X0N8V2H7M3P5R1S6W": { verified_at: "2026-10-07T11:40:25Z", pr: null },
    });
  });

  it("keeps the newest addition when a file was added twice", () => {
    const log = `${R}2026-10-09T00:00:00Z${F}Re-add (#9)\nlessons/x/01K70000000000000000000003.json\n${R}2026-10-01T00:00:00Z${F}Add (#3)\nlessons/x/01K70000000000000000000003.json\n`;
    expect(parseAddedLog(log)["01K70000000000000000000003"]).toEqual({ verified_at: "2026-10-09T00:00:00Z", pr: 9 });
  });
});

describe("teacherPages", () => {
  it("gives each teacher a page at their lowercase login", () => {
    expect(teacherPages(new Map([[1, "Alice"], [2, "bob"]]), new Set([1, 2]))).toEqual(new Map([["alice", 1], ["bob", 2]]));
  });

  it("on a name clash, gives the page to the id whose login came from the API", () => {
    // Id 1 renamed away from "sam" (lookup failed, so we only have the stored name); id 2 now holds "Sam".
    expect(teacherPages(new Map([[1, "sam"], [2, "Sam"]]), new Set([2]))).toEqual(new Map([["sam", 2]]));
  });

  it("gives the page to no one when neither login came from the API", () => {
    expect(teacherPages(new Map([[1, "sam"], [2, "Sam"]]), new Set())).toEqual(new Map());
  });
});

describe("_headers", () => {
  it("sends HSTS for a year on every static asset, without includeSubDomains or preload", () => {
    const text = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const all = text.split(/^\/index\.json$/m)[0]!;
    expect(all.startsWith("/*\n")).toBe(true);
    expect(all).toContain("  Strict-Transport-Security: max-age=31536000\n");
  });
});