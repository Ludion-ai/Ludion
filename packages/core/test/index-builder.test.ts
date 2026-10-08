import { describe, expect, it } from "vitest";
import { buildIndex, resolveLogins, search, type Index } from "../src/index.ts";
import { tokenize } from "../src/search.ts";
import { example, fakeFetch, lesson } from "./helpers.ts";

const opts = { org: "Ludion-ai", repo: "ludion", builtAt: new Date("2026-10-08T09:00:00.123Z") };

describe("buildIndex", () => {
  it("builds the entry shape from the spec, with teacher_id", () => {
    const ex = example();
    const index = buildIndex([ex], { [ex.id]: { verified_at: "2026-10-08T08:57:12Z", pr: 42 } }, new Map(), opts);
    expect(index.built_at).toBe("2026-10-08T09:00:00Z");
    expect(index.lessons[0]).toEqual({
      id: ex.id,
      subject: "python",
      version: ">=3.12",
      claim: ex.claim,
      evidence: ex.evidence,
      teacher: "Ludion-ai",
      teacher_id: 292738933,
      replaces: [],
      verified_by: "test",
      verified_at: "2026-10-08T08:57:12Z",
      pr: 42,
      url: `https://github.com/Ludion-ai/ludion/blob/main/lessons/python/${ex.id}.json`,
    });
    expect(Object.keys(index.lessons[0]!).slice(0, 4)).toEqual(["id", "subject", "version", "claim"]);
    expect(index.teachers).toEqual({ "292738933": { login: "Ludion-ai", lessons: 1, subjects: ["python"] } });
  });

  it("shows the current login of a teacher who renamed their account", () => {
    const a = lesson({ author: "github:alice", author_id: 7 });
    const index = buildIndex([a], {}, new Map([[7, "alice-renamed"]]), opts);
    expect(index.lessons[0]!.teacher).toBe("alice-renamed");
    expect(index.teachers["7"]!.login).toBe("alice-renamed");
  });

  it("falls back to the login stored in the teacher's newest lesson when the lookup failed", () => {
    const older = lesson({ author: "github:old-name", author_id: 7, created_at: "2026-01-01T00:00:00Z" });
    const newer = lesson({ author: "github:new-name", author_id: 7, created_at: "2026-06-01T00:00:00Z" });
    const index = buildIndex([older, newer], {}, new Map(), opts);
    expect(index.lessons.map((l) => l.teacher)).toEqual(["new-name", "new-name"]);
  });

  it("groups by id, not by login: same name, different people", () => {
    const a = lesson({ author: "github:sam", author_id: 1, subject: "node" });
    const b = lesson({ author: "github:Sam", author_id: 2, subject: "python" });
    const index = buildIndex([a, b], {}, new Map(), opts);
    expect(index.teachers).toEqual({
      "1": { login: "sam", lessons: 1, subjects: ["node"] },
      "2": { login: "Sam", lessons: 1, subjects: ["python"] },
    });
  });

  it("includes only the active set, newest verified first", () => {
    const old = lesson();
    const fix = lesson({ replaces: [old.id] });
    const other = lesson();
    const git = {
      [old.id]: { verified_at: "2026-10-01T00:00:00Z", pr: 1 },
      [fix.id]: { verified_at: "2026-10-03T00:00:00Z", pr: 3 },
      [other.id]: { verified_at: "2026-10-02T00:00:00Z", pr: 2 },
    };
    const index = buildIndex([old, fix, other], git, new Map(), opts);
    expect(index.lessons.map((l) => l.pr)).toEqual([3, 2]);
    expect(index.lessons[0]!.replaces).toEqual([old.id]);
  });
});

describe("resolveLogins", () => {
  const user = (id: number, login: string) => () => Response.json({ id, login });

  it("looks up each distinct id once, with headers GitHub requires", async () => {
    const f = fakeFetch({ "https://api.github.com/user/1": user(1, "alice"), "https://api.github.com/user/2": user(2, "Bob") });
    const logins = await resolveLogins([1, 2, 1], f);
    expect(logins).toEqual(new Map([[1, "alice"], [2, "Bob"]]));
    expect(f.calls).toHaveLength(2);
    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^LudionBot/);
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends the read-only token when given", async () => {
    const f = fakeFetch({ "https://api.github.com/user/1": user(1, "alice") });
    await resolveLogins([1], f, "tok");
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("leaves out deleted accounts and network failures", async () => {
    const f = fakeFetch({ "https://api.github.com/user/1": () => new Response("{}", { status: 404 }) });
    expect(await resolveLogins([1, 2], f)).toEqual(new Map());
  });

  it("stops asking once the rate limit is used up", async () => {
    const limited = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const f = fakeFetch({ "https://api.github.com/user/1": limited, "https://api.github.com/user/2": user(2, "bob") });
    expect(await resolveLogins([1, 2], f)).toEqual(new Map());
    expect(f.calls).toHaveLength(1);
  });

  it("ignores an answer for a different id", async () => {
    const f = fakeFetch({ "https://api.github.com/user/1": user(99, "mallory") });
    expect(await resolveLogins([1], f)).toEqual(new Map());
  });
});

describe("search", () => {
  const ex = example();
  const index: Index = buildIndex(
    [ex, lesson({ subject: "node", claim: "Node 22 ships a built-in WebSocket client." })],
    {},
    new Map(),
    opts,
  );

  it("finds the example by a question about distutils", () => {
    expect(search(index, "distutils 3.12")[0]?.id).toBe(ex.id);
  });

  it("matches prefixes and small typos", () => {
    expect(search(index, "distut")[0]?.id).toBe(ex.id);
    expect(search(index, "distutlis")[0]?.id).toBe(ex.id);
  });

  it("filters by subject and limits to k", () => {
    expect(search(index, "distutils", { subject: "node" })).toEqual([]);
    expect(search(index, "websocket distutils", { k: 1 })).toHaveLength(1);
  });

  it("never returns a lesson for a subject name alone", () => {
    expect(search(index, "What is Python?")).toEqual([]);
    expect(search(index, "node python")).toEqual([]);
  });

  it("finds a lesson from an error message pasted as it is", () => {
    expect(search(index, "ModuleNotFoundError: No module named 'distutils'")[0]?.id).toBe(ex.id);
  });

  it("splits words where Latin meets Japanese, and between letters and digits", () => {
    expect(tokenize("distutilsはPython 3.12で削除された？")).toEqual(["distutils", "は", "python", "3.12", "で", "削除", "された"]);
    expect(tokenize("/usr/lib/python3.12/site-packages")).toEqual(["usr", "lib", "python", "3.12", "site", "packages"]);
    expect(search(index, "Python 3.12でdistutilsが使えない")[0]?.id).toBe(ex.id);
  });

  it("keeps flags and pseudo-classes whole", () => {
    expect(tokenize("git switch --discard-changes, sort -V, CSS :has(), built-in")).toEqual(["git", "switch", "--discard-changes", "sort", "-v", "css", ":has", "built", "in"]);
  });

  it("returns nothing for an unrelated question", () => {
    expect(search(index, "kubernetes")).toEqual([]);
  });

  it("ignores common words, so they match nothing on their own", () => {
    expect(search(index, "What is the capital of France?")).toEqual([]);
    expect(search(index, "How do I use it?")).toEqual([]);
  });

  it("prefix-matches only words of 4+ characters: 'I' does not find 'instead'", () => {
    expect(search(index, "I")).toEqual([]);
    expect(search(index, "setu")[0]?.id).toBe(ex.id);
  });

  it("does not count a prefix match on a common word: 'inst' finding 'instead'", () => {
    expect(search(index, "inst")).toEqual([]);
  });

  it("keeps a version number whole", () => {
    expect(tokenize("Python 3.12 removed distutils (PEP 632)")).toEqual(["python", "3.12", "removed", "distutils", "pep", "632"]);
    expect(search(index, "3.12")[0]?.id).toBe(ex.id);
    expect(search(index, "3.1")).toEqual([]);
  });
});
