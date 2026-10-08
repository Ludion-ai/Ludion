/** The runners on the current stable image of each language (ci.md, Runners). */
export type BaseRunner = "python" | "bash" | "node" | "lean";
/** Runners pinned to one version (ci.md, Pinned runners). */
export type PinnedRunner =
  | "python@3.9" | "python@3.10" | "python@3.11" | "python@3.12" | "python@3.13" | "python@3.14"
  | "node@18" | "node@20" | "node@22" | "node@24";
export type Runner = BaseRunner | PinnedRunner;

export type RunEvidence = {
  run: {
    runner: Runner;
    code: string;
    /** pass (the default): exits 0. fail: exits non-zero and its output contains `error`. */
    expect?: "pass" | "fail";
    /** With expect fail only: a sentence the output must contain. */
    error?: string;
  };
};
export type SourceEvidence = { source: { url: string; quote: string } };
export type Evidence = RunEvidence | SourceEvidence;

export type VerifiedBy = "test" | "proof" | "source";

export type Kind = "removed" | "added" | "changed" | "deprecated" | "behaves";

export interface Lesson {
  id: string;
  subject: string;
  version?: string | null;
  kind?: Kind;
  claim: string;
  evidence: Evidence[];
  /** `github:<login>` at signing time. Display only. */
  author: string;
  /** GitHub numeric user id. The teacher's identity. */
  author_id: number;
  replaces?: string[];
  created_at: string;
}

export interface IndexEntry {
  id: string;
  subject: string;
  version?: string;
  claim: string;
  evidence: Evidence[];
  teacher: string;
  teacher_id: number;
  replaces: string[];
  verified_by: VerifiedBy;
  verified_at: string;
  pr: number | null;
  url: string;
}

export interface TeacherSummary {
  login: string;
  lessons: number;
  subjects: string[];
}

export interface Index {
  version: 1;
  built_at: string;
  lessons: IndexEntry[];
  /** Keyed by teacher_id as a string. */
  teachers: Record<string, TeacherSummary>;
}
