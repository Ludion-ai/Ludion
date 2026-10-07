import { summaryLine, type Label, type LessonResult } from "./verify.ts";

export function countByStatus(results: LessonResult[]): Record<"passed" | "failed" | "skipped", number> {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return { passed: count("passed"), failed: count("failed"), skipped: count("skipped") };
}

/** One line per lesson, reasons indented under anything not passed, then the totals. */
export function printResults(results: LessonResult[]): void {
  for (const r of results) {
    console.log(summaryLine(r));
    if (r.status !== "passed") for (const reason of r.reasons) console.log(`  ${reason.replace(/\n/g, "\n  ")}`);
  }
  const c = countByStatus(results);
  console.log(`\n${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped.`);
}

export function labelsOf(results: LessonResult[]): Label[] {
  return [...new Set(results.flatMap((r) => r.labels))].sort();
}

const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function stepSummary(results: LessonResult[]): string {
  const c = countByStatus(results);
  const rows = results.map((r) => {
    const why = r.status === "passed" ? (r.labels.includes("retract") ? "retracted" : "") : r.reasons.join("\n");
    return `| ${r.status} | \`${r.id ?? r.file}\` | ${escapeCell((r.claim ?? "").slice(0, 60))} | ${escapeCell(why)} |`;
  });
  return [
    `### Lessons: ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped`,
    "",
    "| Status | Lesson | Claim | Details |",
    "| - | - | - | - |",
    ...rows,
    "",
  ].join("\n");
}
