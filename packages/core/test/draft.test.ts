import { describe, expect, it } from "vitest";
import { validateDraft } from "../src/index.ts";

const draft = {
  subject: "python",
  version: ">=3.12",
  claim: "Python 3.12 removed the distutils module from the standard library.",
  evidence: [{ source: { url: "https://peps.python.org/pep-0632/", quote: "Code that imports distutils will no longer work" } }],
};

describe("validateDraft", () => {
  it("accepts a draft and returns it in canonical order", () => {
    const shuffled = { evidence: draft.evidence, claim: draft.claim, version: draft.version, subject: draft.subject };
    const r = validateDraft(shuffled);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.draft)).toEqual(["subject", "version", "claim", "evidence"]);
  });

  it("does not ask for id, author, author_id, or created_at", () => {
    expect(validateDraft({ subject: "python", claim: draft.claim, evidence: draft.evidence }).ok).toBe(true);
  });

  it("refuses the fields that signing sets", () => {
    const r = validateDraft({ ...draft, author: "github:mallory", author_id: 666 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(["/author", "/author_id"]);
  });

  it("reports schema errors with field messages", () => {
    const r = validateDraft({ ...draft, claim: "short" });
    expect(r).toEqual({ ok: false, errors: [{ path: "/claim", message: "Write one sentence of 10 to 400 characters." }] });
  });

  it("refuses anything that is not an object", () => {
    for (const v of [null, "x", [draft], 3]) expect(validateDraft(v).ok).toBe(false);
  });
});
