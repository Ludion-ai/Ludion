import type { EvidenceV0, EvidenceV1, Lesson, LessonV0, LessonV1 } from "./types.ts";
import { isV1 } from "./types.ts";

function formatEvidenceV0(e: EvidenceV0): EvidenceV0 {
  if ("run" in e) return { run: { runner: e.run.runner, code: e.run.code } };
  return { source: { url: e.source.url, quote: e.source.quote } };
}

function formatEvidenceV1(e: EvidenceV1): EvidenceV1 {
  if ("test" in e) {
    const test: Record<string, unknown> = { runtime: e.test.runtime };
    if (e.test.packages != null) test.packages = Object.fromEntries(Object.entries(e.test.packages).sort(([a], [b]) => a.localeCompare(b)));
    test.code = e.test.code;
    if (e.test.expect != null) test.expect = e.test.expect;
    if (e.test.error != null) test.error = e.test.error;
    return { test } as EvidenceV1;
  }
  return { source: { url: e.source.url, quote: e.source.quote } };
}

function orderV0(l: LessonV0): Record<string, unknown> {
  const out: Record<string, unknown> = { id: l.id, subject: l.subject };
  if (l.version != null) out.version = l.version;
  out.claim = l.claim;
  out.evidence = l.evidence.map(formatEvidenceV0);
  out.author = l.author;
  out.author_id = l.author_id;
  if (l.replaces != null) out.replaces = l.replaces;
  out.created_at = l.created_at;
  return out;
}

function orderV1(l: LessonV1): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: 1,
    id: l.id,
    subject: l.subject,
    package: { ecosystem: l.package.ecosystem, name: l.package.name },
    versions: l.versions,
    kind: l.kind,
    symbol: l.symbol,
  };
  if (l.replacement != null) out.replacement = l.replacement;
  out.signal = l.signal;
  if (l.detail != null) out.detail = l.detail;
  out.evidence = l.evidence.map(formatEvidenceV1);
  out.author = l.author;
  out.author_id = l.author_id;
  if (l.drafted_by != null) out.drafted_by = l.drafted_by;
  if (l.replaces != null) out.replaces = l.replaces;
  out.created_at = l.created_at;
  return out;
}

/** Canonical file contents: keys in schema order, absent optional fields omitted, 2-space indent, trailing newline. */
export function formatLesson(lesson: Lesson): string {
  return JSON.stringify(isV1(lesson) ? orderV1(lesson) : orderV0(lesson), null, 2) + "\n";
}
