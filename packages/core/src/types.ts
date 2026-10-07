export type Runner = "python" | "bash" | "node" | "lean";

export type RunEvidence = { run: { runner: Runner; code: string } };
export type SourceEvidence = { source: { url: string; quote: string } };
export type Evidence = RunEvidence | SourceEvidence;

export type VerifiedBy = "test" | "proof" | "source";

export interface Lesson {
  id: string;
  subject: string;
  version?: string | null;
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
