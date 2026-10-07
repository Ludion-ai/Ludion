import type { GitInfo } from "@ludion/core";

const RECORD = "\x1e";
const FIELD = "\x1f";
/** `git log` format for parseAddedLog: one record per commit, then the files it added. */
export const ADDED_LOG_FORMAT = `${RECORD}%cI${FIELD}%s`;

/**
 * Parse `git log --diff-filter=A --name-only --format=<ADDED_LOG_FORMAT> -- lessons/` into GitInfo:
 * for each lesson, the commit that added it. Squash merges end their subject with "(#<number>)".
 * Log order is newest first, so the first commit seen for a file is its latest addition.
 */
export function parseAddedLog(log: string): GitInfo {
  const info: GitInfo = {};
  for (const record of log.split(RECORD)) {
    const [header = "", ...files] = record.split("\n").filter((l) => l.trim() !== "");
    const [date, subject = ""] = header.split(FIELD);
    if (!date) continue;
    const verified_at = new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
    const pr = /\(#(\d+)\)\s*$/.exec(subject);
    for (const file of files) {
      const m = /^lessons\/[^/]+\/([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(file.trim());
      if (m && !(m[1]! in info)) info[m[1]!] = { verified_at, pr: pr ? Number(pr[1]) : null };
    }
  }
  return info;
}
