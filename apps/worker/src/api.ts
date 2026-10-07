// /api/session, /api/check, /api/teach, /api/pr/:number (worker.md).
import type { Hono } from "hono";
import { checkSource, formatLesson, newId, validateDraft, verifiedBy, type Draft, type FieldError, type Lesson } from "@ludion/core";
import type { AppEnv, Env } from "./app.ts";
import { currentSession } from "./auth.ts";
import { LESSONS_ORG, LESSONS_REPO } from "./config.ts";
import type { Deps } from "./deps.ts";
import { GitHubError, Repo, installationToken, openTeachingPr, prStatus } from "./github.ts";
import { apiError, csrfProblem, json } from "./http.ts";
import { lessonsIndex } from "./lessons-index.ts";
import type { Session } from "./session.ts";

const DAILY_LIMIT = 20;
const SOURCE_NOT_CONFIRMED = "This source could not be confirmed.";

type Gate = { session: Session; body: unknown } | { error: Response };

/** Error bodies: {error, message} plus fields; /api/check adds ok:false. */
function failure(check: boolean, status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return apiError(status, error, message, check ? { ok: false, ...extra } : extra);
}

/** Session, then Origin, then JSON (worker.md, steps 1 of /api/check and /api/teach). */
async function gate(request: Request, env: Env, deps: Deps, check: boolean): Promise<Gate> {
  const session = await currentSession(request, env, deps.now());
  if (!session) {
    return { error: failure(check, 401, "signin_required", "Sign in with GitHub to teach.", { signin_url: `${env.SITE_URL}/auth/login?next=/teach` }) };
  }
  const csrf = csrfProblem(request, env.SITE_URL);
  if (csrf === "forbidden_origin") return { error: failure(check, 403, "forbidden_origin", "This request did not come from ludion.ai. Teach from https://ludion.ai/teach.") };
  if (csrf === "bad_request") return { error: failure(check, 400, "bad_request", "Send the draft as JSON with Content-Type: application/json.") };
  try {
    return { session, body: await request.json() };
  } catch {
    return { error: failure(check, 400, "bad_request", "The body is not valid JSON. Send the draft as a JSON object.") };
  }
}

/** One count per request on the shared per-account budget: 10 a minute across /api/check and /api/teach. */
async function rateLimited(env: Env, session: Session): Promise<boolean> {
  const { success } = await env.SOURCE_CHECK_LIMITER.limit({ key: `user:${session.id}` });
  return !success;
}

type DraftCheck = { draft: Draft } | { error: Response };

/** Validate, check every source, check replaces against the active set (worker.md, POST /api/check). */
async function checkDraft(body: unknown, env: Env, deps: Deps, check: boolean, requestId: string): Promise<DraftCheck> {
  const valid = validateDraft(body);
  if (!valid.ok) {
    return { error: failure(check, 422, "invalid_draft", "The draft has problems. Fix the fields listed in errors and try again.", { errors: valid.errors satisfies FieldError[] }) };
  }
  const { draft } = valid;
  const sources = draft.evidence.flatMap((e) => ("source" in e ? [e.source] : []));
  const results = await Promise.all(sources.map((s) => checkSource(s.url, s.quote, deps.fetch)));
  const missing = results.findIndex((r) => !r.found);
  if (missing >= 0) {
    // Never forward the page's status, body, or checkSource's reason; log the reason with the request id only.
    const r = results[missing]!;
    console.log(JSON.stringify({ rid: requestId, source_check: "not_confirmed", reason: r.found ? "" : r.reason }));
    return { error: failure(check, 422, "source_not_found", SOURCE_NOT_CONFIRMED, { url: sources[missing]!.url }) };
  }
  if (draft.replaces?.length) {
    const active = new Set((await lessonsIndex(env.ASSETS)).lessons.map((l) => l.id));
    const unknown = draft.replaces.find((id) => !active.has(id));
    if (unknown) return { error: failure(check, 422, "unknown_replaces", "The lesson you're correcting isn't active anymore. Check its link.", { id: unknown }) };
  }
  return { draft };
}

const firstChars = (text: string, n: number) => text.slice(0, n).trimEnd();

export function evidenceSummary(draft: Draft): string {
  return draft.evidence
    .map((e) => ("run" in e ? (e.run.runner === "lean" ? "proof (lean)" : `test (${e.run.runner})`) : `source (${new URL(e.source.url).host})`))
    .join(", ");
}

/** Commit message, PR title, and PR body (worker.md, POST /api/teach). */
export function teachingTexts(lesson: Lesson, session: Session): { commitMessage: string; title: string; body: string } {
  const title = `Teach ${lesson.subject}: ${firstChars(lesson.claim, 60)}`;
  const trailer = `Taught-by: ${session.login} (${session.id})`;
  const subjectLine = `Subject: ${lesson.subject}${lesson.version ? ` ${lesson.version}` : ""}`;
  const meta = JSON.stringify({ id: lesson.id, subject: lesson.subject, teacher: session.login, teacher_id: session.id });
  return {
    commitMessage: `${title}\n\n${trailer}\n`,
    title,
    body: [lesson.claim, "", subjectLine, `Evidence: ${evidenceSummary(lesson)}`, `Taught by @${session.login}, signed on ludion.ai.`, trailer, "", `<!-- ludion ${meta} -->`, ""].join("\n"),
  };
}

function appCredentials(env: Env) {
  return { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
}

async function repoClient(env: Env, deps: Deps): Promise<Repo> {
  return new Repo(deps.fetch, await installationToken(appCredentials(env), deps.fetch, deps.now()), LESSONS_ORG, LESSONS_REPO);
}

const GITHUB_FAILED = "GitHub didn't respond. Nothing was published. Try again in a minute.";

export function mountApi(app: Hono<AppEnv>, deps: Deps): void {
  app.get("/api/session", async (c) => {
    const session = await currentSession(c.req.raw, c.env, deps.now());
    if (!session) return apiError(401, "signin_required", "You are not signed in.", { signin_url: `${c.env.SITE_URL}/auth/login?next=/teach` });
    return json({ login: session.login, avatar_url: session.avatar_url });
  });

  app.post("/api/check", async (c) => {
    const g = await gate(c.req.raw, c.env, deps, true);
    if ("error" in g) return g.error;
    if (await rateLimited(c.env, g.session)) {
      return failure(true, 429, "rate_limited", "You have checked too many lessons in the last minute. Wait a minute and try again.");
    }
    const d = await checkDraft(g.body, c.env, deps, true, c.get("requestId"));
    if ("error" in d) return d.error;
    const sources = d.draft.evidence.flatMap((e) => ("source" in e ? [{ url: e.source.url, found: true }] : []));
    return json({ ok: true, verified_by: verifiedBy(d.draft), sources });
  });

  app.post("/api/teach", async (c) => {
    const g = await gate(c.req.raw, c.env, deps, false);
    if ("error" in g) return g.error;
    const { session } = g;
    if (await rateLimited(c.env, session)) {
      return failure(false, 429, "rate_limited", "You have checked too many lessons in the last minute. Wait a minute and try again.");
    }
    const d = await checkDraft(g.body, c.env, deps, false, c.get("requestId"));
    if ("error" in d) return d.error;

    let repo: Repo;
    try {
      repo = await repoClient(c.env, deps);
      const since = new Date(deps.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      if ((await repo.taughtSince(session.login, session.id, since)) >= DAILY_LIMIT) {
        return failure(false, 429, "daily_limit", "You've taught 20 lessons in the last 24 hours. Come back tomorrow.");
      }
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      return failure(false, 502, "github_error", GITHUB_FAILED);
    }

    const nowMs = deps.now();
    const lesson: Lesson = {
      id: newId(nowMs),
      ...d.draft,
      author: `github:${session.login}`,
      author_id: session.id,
      created_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const path = `lessons/${lesson.subject}/${lesson.id}.json`;
    const texts = teachingTexts(lesson, session);
    try {
      const pr = await openTeachingPr(repo, {
        subject: lesson.subject,
        id: lesson.id,
        path,
        fileText: formatLesson(lesson),
        ...texts,
        authorName: session.login,
        authorEmail: `${session.id}+${session.login}@users.noreply.github.com`,
      });
      return json({ id: lesson.id, pr: pr.number, pr_url: pr.html_url, lesson_url: `${c.env.SITE_URL}/lessons/${lesson.id}` }, 201);
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      return failure(false, 502, "github_error", GITHUB_FAILED);
    }
  });

  app.get("/api/pr/:number{[0-9]{1,9}}", async (c) => {
    const number = Number(c.req.param("number"));
    const cache = caches.default;
    const key = new Request(new URL(`/api/pr/${number}`, c.env.SITE_URL));
    const hit = await cache.match(key);
    if (hit) return hit;
    try {
      const repo = await repoClient(c.env, deps);
      const s = await prStatus(repo, number);
      const res = json({ pr: number, status: s.status, pr_url: s.html_url, merged_at: s.merged_at }, 200, { "Cache-Control": "public, max-age=30" });
      c.executionCtx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      if (err.status === 404) return apiError(404, "not_found", `There is no pull request #${number} in the lessons repo. Check the number.`);
      return apiError(502, "github_error", "GitHub didn't respond. Try again in a minute.");
    }
  });
}
