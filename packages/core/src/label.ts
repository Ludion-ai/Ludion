import type { Evidence, Lesson, VerifiedBy } from "./types.ts";
import { isV1 } from "./types.ts";

/**
 * The label shown to readers, derived, never stored. It never says more than the evidence shows:
 * differential (format 1): a test expected to pass and a test expected to fail on different pinned versions;
 * proof: any Lean run (format 0); test: any test or run; source: sources only.
 */
export function verifiedBy(lesson: Lesson): VerifiedBy {
  if (isV1(lesson)) {
    const tests = lesson.evidence.flatMap((e) => ("test" in e ? [e.test] : []));
    const pass = tests.filter((t) => (t.expect ?? "pass") === "pass");
    const fail = tests.filter((t) => t.expect === "fail");
    const pinned = (t: (typeof tests)[number]) => `${t.runtime} ${JSON.stringify(t.packages ?? {})}`;
    if (pass.some((p) => fail.some((f) => pinned(p) !== pinned(f)))) return "differential";
    return tests.length > 0 ? "test" : "source";
  }
  const runs = lesson.evidence.filter((e) => "run" in e);
  if (runs.some((e) => e.run.runner === "lean")) return "proof";
  if (runs.length > 0) return "test";
  return "source";
}

/** A format 0 run or a format 1 test in one shape, for display. Undefined for a source. */
export function asTest(e: Evidence): { runtime: string; code: string; packages?: Record<string, string>; expect?: "pass" | "fail"; error?: string } | undefined {
  if ("run" in e) return { runtime: e.run.runner, code: e.run.code };
  if ("test" in e) return e.test;
  return undefined;
}