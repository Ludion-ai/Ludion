// Every UI string. Japanese will be a translation of this file, not a refactor.
import type { VerifiedBy } from "@ludion/core";
export const en = {
  site: {
    name: "Ludion",
    description: "Ludion is a public, writable AI model. People teach it, machines verify every lesson, and every assistant can use it.",
  },
  nav: {
    label: "Main",
    lessons: "Lessons",
  },
  home: {
    title: "Ludion: teach it once",
    headline: "Teach it once.",
    sub: "Everyone's AI learns it in minutes. Your name stays on it.",
    replayTitle: "How a lesson passes",
    checking: "Checking",
    replay: (by: VerifiedBy, date: string) =>
      `A replay of how this lesson passed: ${by === "test" ? "CI ran its test" : by === "differential" ? "CI ran its tests on two versions" : by === "proof" ? "Lean checked its proof" : "its quote was found on the source page"}, and it was verified on ${date}.`,
    logTitle: (by: VerifiedBy, runner: string) => (by === "source" ? "Source check" : by === "proof" ? "Proof check (lean)" : `Test (${runner})`),
    recent: "Recently verified",
    seeLessons: "See all lessons",
  },
  lessons: {
    title: "Lessons",
    intro: (shown: number, total: number) =>
      shown < total ? `The newest ${shown} of ${total} lessons.` : total === 1 ? "1 lesson." : `${total} lessons, newest first.`,
    empty: "No lessons yet.",
  },
  lesson: {
    verifiedBy: { test: "Verified by test", differential: "Verified across versions", proof: "Verified by proof", source: "Verified by source" },
    on: (date: string) => `on ${date}`,
    appliesTo: (subject: string, version?: string | null) => `Applies to ${subject}${version ? ` ${version}` : ""}`,
    taughtBy: "Taught by",
    evidence: "Evidence",
    test: (runner: string) => `Test (${runner})`,
    proof: "Proof (Lean)",
    mark: { test: "exit 0", differential: "pass / fail", proof: "proved", source: "quote found" },
    source: "Source",
    copy: "Copy",
    copied: "Copied",
    corrects: "Corrects",
    correctedBy: "This lesson was corrected by",
    viewFile: "View the file on GitHub",
    pullRequest: (n: number) => `Pull request #${n}`,
  },
  record: {
    verified: "Verified",
    appliesTo: "Applies to",
    teacher: "Teacher",
    check: "Check it yourself",
  },
  teacher: {
    title: (login: string) => `@${login} on Ludion`,
    summary: (lessons: number, subjects: number) =>
      `${lessons} ${lessons === 1 ? "lesson" : "lessons"} in ${subjects} ${subjects === 1 ? "subject" : "subjects"}`,
    profile: "GitHub profile",
    subjects: "Subjects",
  },
  footer: {
    count: (lessons: number, teachers: number) =>
      `${lessons} ${lessons === 1 ? "lesson" : "lessons"} from ${teachers} ${teachers === 1 ? "teacher" : "teachers"}.`,
    license: "Lessons are CC BY-SA 4.0. Code is Apache-2.0.",
    github: "GitHub",
  },
  notFound: {
    title: "No page here",
    body: "No page here.",
    search: "Search the lessons",
    rest: " or teach one.",
  },
};

/** "node@24, vitest@5.0.3" or "python, expected to fail". The heading of a test on a lesson page. */
export const testLabel = (t: { runtime: string; packages?: Record<string, string>; expect?: "pass" | "fail" }): string =>
  [t.runtime, ...Object.entries(t.packages ?? {}).map(([n, v]) => `${n}@${v}`)].join(", ") + (t.expect === "fail" ? ", expected to fail" : "");

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** "Oct 8, 2026" */
export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));
