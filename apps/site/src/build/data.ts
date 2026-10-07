// Build-time data for every page. Runs in Node during `astro build` only; never shipped to the browser.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndex, resolveLogins, storedLogin, validateLesson, verifiedBy,
  type GitInfo, type Index, type Lesson, type VerifiedBy,
} from "@ludion/core";
import { ADDED_LOG_FORMAT, parseAddedLog } from "./git-info.ts";
import { teacherPages } from "./teacher-pages.ts";

export interface Config {
  org: string;
  repo: string;
  site: string;
}

export interface LessonPage {
  lesson: Lesson;
  teacher: string;
  verified_by: VerifiedBy;
  verified_at: string;
  pr: number | null;
  /** Lessons this one corrects, and the lesson that corrects it, if any. */
  corrects: string[];
  correctedBy: string | null;
}

export interface SiteData {
  config: Config;
  /** index.json: the active set. */
  index: Index;
  /** Every lesson on main, replaced ones included, newest verified first. */
  pages: LessonPage[];
  /** Lowercase login → teacher id that owns /teachers/<login>/. */
  teacherPages: Map<string, number>;
  /** Current login for a teacher id. */
  loginOf: (id: number) => string;
  /** Path of the teacher's page, or null if they have none. */
  teacherHref: (id: number) => string | null;
  /** Avatar URL by id (survives renames). Sample builds use monograms, never real GitHub accounts. */
  avatarOf: (id: number, size: number) => string;
  /** True when built from apps/site/samples (LUDION_SAMPLES=1). */
  samples: boolean;
}

const SIZE_WARNING = 5 * 1024 * 1024;

// Sample lessons for checking the design (site.md, Design). They live outside lessons/, build only with
// LUDION_SAMPLES=1 into dist-samples (astro.config.mjs), and never in a deploy build.
const SAMPLES = process.env.LUDION_SAMPLES === "1";
if (SAMPLES && (process.env.WORKERS_CI || process.env.CF_PAGES)) {
  throw new Error("LUDION_SAMPLES=1 is set in a Cloudflare build. Sample lessons must never be deployed; unset it.");
}

function sampleMeta(root: string): { teachers: Record<string, string>; git: GitInfo } {
  return JSON.parse(readFileSync(join(root, "apps/site/samples/meta.json"), "utf8"));
}

/** A data: URI avatar with the login's first letter, for fictional sample teachers. */
function monogram(login: string, id: number): string {
  const hue = (id * 47) % 360;
  const letter = login.charAt(0).toUpperCase().replace(/[^A-Z0-9]/, "?");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="hsl(${hue} 35% 42%)"/><text x="20" y="26.5" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="600" fill="#fff">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function readLessons(dir: string): Lesson[] {
  const lessons: Lesson[] = [];
  for (const subject of readdirSync(dir, { withFileTypes: true })) {
    if (!subject.isDirectory()) continue;
    for (const file of readdirSync(join(dir, subject.name))) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, subject.name, file);
      const v = validateLesson(JSON.parse(readFileSync(path, "utf8")));
      if (!v.ok) throw new Error(`${path} is not a valid lesson: ${v.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
      lessons.push(v.lesson);
    }
  }
  return lessons;
}

function gitInfo(root: string): GitInfo {
  if (git(root, "rev-parse", "--is-shallow-repository").trim() === "true") {
    console.log("[ludion] Shallow clone: fetching full history for verified_at and pr.");
    git(root, "fetch", "--unshallow", "--quiet");
  }
  return parseAddedLog(git(root, "log", "--diff-filter=A", "--name-only", `--format=${ADDED_LOG_FORMAT}`, "--", "lessons/"));
}

async function load(): Promise<SiteData> {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
  const config = JSON.parse(readFileSync(join(root, "ludion.config.json"), "utf8")) as Config;
  const samples = SAMPLES ? sampleMeta(root) : null;
  const all = readLessons(join(root, samples ? "apps/site/samples/lessons" : "lessons"));
  const info = samples ? samples.git : gitInfo(root);

  const ids = new Set(all.map((l) => l.author_id));
  const resolved = samples
    ? new Map(Object.entries(samples.teachers).map(([id, login]) => [Number(id), login]))
    : await resolveLogins(ids, fetch, process.env.GITHUB_READ_TOKEN || undefined);
  for (const id of ids) {
    if (!resolved.has(id)) console.warn(`[ludion] Could not look up GitHub user ${id}; using the login stored in their newest lesson.`);
  }
  // Current login for every teacher, active or not: the API's answer, else the newest stored login.
  const logins = new Map(resolved);
  for (const l of [...all].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    if (!logins.has(l.author_id)) logins.set(l.author_id, storedLogin(l.author));
  }

  const index = buildIndex(all, info, resolved, config);
  const json = JSON.stringify(index);
  if (json.length > SIZE_WARNING) console.warn(`[ludion] index.json is ${(json.length / 1048576).toFixed(1)} MB, above 5 MB. The Worker and the ask box load it whole.`);

  const correctedBy = new Map<string, string>();
  for (const l of all) for (const old of l.replaces ?? []) correctedBy.set(old, l.id);
  const pages: LessonPage[] = all
    .map((lesson) => ({
      lesson,
      teacher: logins.get(lesson.author_id)!,
      verified_by: verifiedBy(lesson),
      verified_at: info[lesson.id]?.verified_at ?? lesson.created_at,
      pr: info[lesson.id]?.pr ?? null,
      corrects: lesson.replaces ?? [],
      correctedBy: correctedBy.get(lesson.id) ?? null,
    }))
    .sort((a, b) => (a.verified_at < b.verified_at ? 1 : a.verified_at > b.verified_at ? -1 : 0));

  // Pages only for teachers with active lessons.
  const activeTeachers = new Map([...logins].filter(([id]) => String(id) in index.teachers));
  const owners = teacherPages(activeTeachers, new Set(resolved.keys()));
  const pageOf = new Map([...owners].map(([name, id]) => [id, name]));

  return {
    config,
    index,
    pages,
    teacherPages: owners,
    loginOf: (id) => logins.get(id) ?? String(id),
    teacherHref: (id) => (pageOf.has(id) ? `/@${pageOf.get(id)}` : null),
    avatarOf: (id, size) => (samples ? monogram(logins.get(id) ?? "?", id) : `https://avatars.githubusercontent.com/u/${id}?s=${size * 2}`),
    samples: samples !== null,
  };
}

let cached: Promise<SiteData> | undefined;
/** Loaded once per build and shared by every page. */
export function siteData(): Promise<SiteData> {
  return (cached ??= load());
}
