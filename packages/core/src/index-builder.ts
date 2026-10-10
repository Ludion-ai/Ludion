import { activeSet } from "./active.ts";
import { claimOf, versionOf } from "./claim.ts";
import { verifiedBy } from "./label.ts";
import { isV1, type Index, type IndexEntry, type Lesson, type TeacherSummary } from "./types.ts";

/** From `git log` of each lesson file: the commit that added it. Keyed by lesson id. */
export type GitInfo = Record<string, { verified_at: string; pr: number | null }>;

export interface BuildOptions {
  org: string;
  repo: string;
  builtAt?: Date;
}

export function storedLogin(author: string): string {
  return author.replace(/^github:/, "");
}

/** index.json from all lessons on main. Only the active set is included, newest first. */
export function buildIndex(lessons: Lesson[], gitInfo: GitInfo, logins: Map<number, string>, options: BuildOptions): Index {
  const active = activeSet(lessons);
  // Fallback login per teacher: the one stored in their newest lesson.
  const fallback = new Map<number, { login: string; at: string }>();
  for (const l of active) {
    const prev = fallback.get(l.author_id);
    if (!prev || l.created_at > prev.at) fallback.set(l.author_id, { login: storedLogin(l.author), at: l.created_at });
  }
  const loginOf = (id: number) => logins.get(id) ?? fallback.get(id)!.login;

  const entries: IndexEntry[] = active.map((l) => {
    const git = gitInfo[l.id];
    const version = versionOf(l);
    return {
      id: l.id,
      ...(isV1(l) ? { format: 1 as const } : {}),
      subject: l.subject,
      ...(version != null ? { version } : {}),
      claim: claimOf(l),
      ...(isV1(l)
        ? {
            package: l.package,
            kind: l.kind,
            symbol: l.symbol,
            ...(l.replacement != null ? { replacement: l.replacement } : {}),
            signal: l.signal,
            ...(l.drafted_by != null ? { drafted_by: l.drafted_by } : {}),
          }
        : {}),
      evidence: l.evidence,
      teacher: loginOf(l.author_id),
      teacher_id: l.author_id,
      replaces: l.replaces ?? [],
      verified_by: verifiedBy(l),
      verified_at: git?.verified_at ?? l.created_at,
      pr: git?.pr ?? null,
      url: `https://github.com/${options.org}/${options.repo}/blob/main/lessons/${l.subject}/${l.id}.json`,
    };
  });
  entries.sort((a, b) => (a.verified_at < b.verified_at ? 1 : a.verified_at > b.verified_at ? -1 : 0));

  const teachers: Record<string, TeacherSummary> = {};
  for (const e of entries) {
    const t = (teachers[String(e.teacher_id)] ??= { login: e.teacher, lessons: 0, subjects: [] });
    t.lessons++;
    if (!t.subjects.includes(e.subject)) t.subjects.push(e.subject);
  }
  for (const t of Object.values(teachers)) t.subjects.sort();

  return { version: 1, built_at: (options.builtAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"), lessons: entries, teachers };
}
