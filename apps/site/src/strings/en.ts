// Every UI string. Japanese will be a translation of this file, not a refactor.
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
    title: "Ludion: lessons people taught and machines verified",
    headline: "A public AI model that people teach.",
    sub: "Every lesson is checked by a test, a proof, or a cited source before it is served, and it keeps its teacher's name.",
    seeLessons: "See the lessons",
    recent: "Recently verified",
  },
  lessons: {
    title: "Lessons",
    intro: (shown: number, total: number) => (shown < total ? `The newest ${shown} of ${total} lessons.` : `${total} lessons, newest first.`),
    empty: "No lessons yet.",
  },
  lesson: {
    verifiedBy: { test: "Verified by test", proof: "Verified by proof", source: "Verified by source" },
    on: (date: string) => `on ${date}`,
    appliesTo: (subject: string, version?: string | null) => `Applies to ${subject}${version ? ` ${version}` : ""}`,
    taughtBy: "Taught by",
    evidence: "Evidence",
    test: (runner: string) => `Test (${runner})`,
    proof: "Proof (Lean)",
    copy: "Copy",
    copied: "Copied",
    corrects: "Corrects",
    correctedBy: "This lesson was corrected by",
    viewFile: "View the file on GitHub",
    pullRequest: (n: number) => `Pull request #${n}`,
  },
  teacher: {
    title: (login: string) => `@${login} on Ludion`,
    summary: (lessons: number, subjects: number) =>
      `${lessons} ${lessons === 1 ? "lesson" : "lessons"} in ${subjects} ${subjects === 1 ? "subject" : "subjects"}`,
    profile: "GitHub profile",
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

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** "Oct 8, 2026" */
export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));
