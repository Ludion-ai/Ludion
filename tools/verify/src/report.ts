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

/** Spaces other than U+0020, control, format, and variation-selector characters, shown as ⟨U+XXXX⟩. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

export function showInvisible(line: string): string {
  return line.replace(UNSEEN, (c) => (c === " " ? c : `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`));
}

/** For the reviewer: the text assistants will read, invisible characters made visible, and what to check. */
function reviewBlock(r: LessonResult): string {
  const text = r.askText!.split("\n").map(showInvisible).join("\n");
  const fence = text.includes("```") ? "~~~" : "```";
  return [
    `#### \`${r.id}\`: what assistants will read`,
    "",
    `${fence}text`,
    text,
    fence,
    "",
    "Before merging, check:",
    "",
    `- [ ] The claim states only a fact about \`${r.subject}\`.`,
    "- [ ] The evidence checks that fact.",
    "- [ ] Nothing in it instructs an AI or the reader.",
    `- [ ] The version range is right: ${r.version ? `\`${r.version}\`` : "none given"}.`,
    "",
  ].join("\n");
}

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
    ...results.filter((r) => r.askText).map(reviewBlock),
  ].join("\n");
}
