// ---- Format 0: the first lessons (lessons/lessons-v0.schema.json). Frozen: existing files stay valid; new lessons are format 1.

export type Runner = "python" | "bash" | "node" | "lean";

export type RunEvidence = { run: { runner: Runner; code: string } };
export type SourceEvidence = { source: { url: string; quote: string } };
export type EvidenceV0 = RunEvidence | SourceEvidence;

export interface LessonV0 {
  id: string;
  subject: string;
  version?: string | null;
  claim: string;
  evidence: EvidenceV0[];
  /** `github:<login>` at signing time. Display only. */
  author: string;
  /** GitHub numeric user id. The teacher's identity. */
  author_id: number;
  replaces?: string[];
  created_at: string;
}

// ---- Format 1 (lessons/lessons.schema.json): structured fields, a generated claim (claim.ts), a grounded detail.

export type Ecosystem = "npm" | "pypi" | "runtime";
export type Kind = "removed" | "renamed" | "deprecated" | "added" | "default" | "behavior";
export type Signal = "loud" | "silent";
export type Runtime =
  | "node@18" | "node@20" | "node@22" | "node@24"
  | "python@3.9" | "python@3.10" | "python@3.11" | "python@3.12" | "python@3.13" | "python@3.14";

export type TestEvidence = {
  test: {
    runtime: Runtime;
    /** Exact versions installed before the test runs (npm for node, pypi for python). */
    packages?: Record<string, string>;
    code: string;
    /** pass (the default): exits 0. fail: exits non-zero and the output contains `error`. */
    expect?: "pass" | "fail";
    error?: string;
  };
};
export type EvidenceV1 = TestEvidence | SourceEvidence;

export interface LessonV1 {
  format: 1;
  id: string;
  subject: string;
  package: { ecosystem: Ecosystem; name: string };
  /** Semver range of the package where the fact holds. */
  versions: string;
  kind: Kind;
  symbol: string;
  replacement?: string;
  signal: Signal;
  detail?: string;
  evidence: EvidenceV1[];
  author: string;
  author_id: number;
  /** "agent" when an agent drafted it (a seed lesson). */
  drafted_by?: "agent";
  replaces?: string[];
  created_at: string;
}

export type Lesson = LessonV0 | LessonV1;
export type Evidence = EvidenceV0 | EvidenceV1;

export const isV1 = (l: Lesson): l is LessonV1 => (l as LessonV1).format === 1;

/** test: any run or test; proof: any Lean run; differential: a test that passes on one version and fails as expected on another. */
export type VerifiedBy = "test" | "proof" | "source" | "differential";

export interface IndexEntry {
  id: string;
  /** Lesson format: absent for format 0. */
  format?: 1;
  subject: string;
  /** Where the fact holds: format 0's `version`, format 1's `versions`. */
  version?: string;
  /** The sentence assistants read: format 0's claim, or format 1's generated claim. */
  claim: string;
  package?: { ecosystem: Ecosystem; name: string };
  kind?: Kind;
  symbol?: string;
  replacement?: string;
  signal?: Signal;
  drafted_by?: "agent";
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
