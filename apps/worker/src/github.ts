// GitHub App calls: installation token, daily-limit search, opening a teaching PR, PR status.
import { base64url } from "./session.ts";

export type FetchFn = (input: string | Request, init?: RequestInit) => Promise<Response>;

export interface AppCredentials {
  appId: string;
  installationId: string;
  /** PKCS#8 PEM. */
  privateKey: string;
}

export class GitHubError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const API = "https://api.github.com";
const USER_AGENT = "Ludion (+https://ludion.ai)";
const encoder = new TextEncoder();

function pemToBytes(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** RS256 JWT for the App: iat now minus 60 s, exp now plus 9 min, iss app id. */
export async function appJwt(creds: AppCredentials, nowSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToBytes(creds.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: creds.appId })));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(signature)}`;
}

let tokenCache: { token: string; expiresAt: number; installationId: string } | undefined;

/** For tests only. */
export function resetTokenCache(): void {
  tokenCache = undefined;
}

/** Installation token, cached in module scope until 5 minutes before it expires. */
export async function installationToken(creds: AppCredentials, fetchFn: FetchFn, nowMs: number): Promise<string> {
  if (tokenCache && tokenCache.installationId === creds.installationId && nowMs < tokenCache.expiresAt - 5 * 60_000) return tokenCache.token;
  const jwt = await appJwt(creds, Math.floor(nowMs / 1000));
  const res = await fetchFn(`${API}/app/installations/${creds.installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new GitHubError(`installation token: HTTP ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache = { token: body.token, expiresAt: Date.parse(body.expires_at), installationId: creds.installationId };
  return body.token;
}

/** A small client for the lessons repo with the installation token. */
export class Repo {
  private readonly fetchFn: FetchFn;
  private readonly token: string;
  readonly org: string;
  readonly repo: string;

  constructor(fetchFn: FetchFn, token: string, org: string, repo: string) {
    this.fetchFn = fetchFn;
    this.token = token;
    this.org = org;
    this.repo = repo;
  }

  async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [200, 201]): Promise<T> {
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!okStatuses.includes(res.status)) throw new GitHubError(`${method} ${path}: HTTP ${res.status}`, res.status);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  get base(): string {
    return `/repos/${this.org}/${this.repo}`;
  }

  /** PRs whose body carries this teacher's trailer, created since `sinceIso`. */
  async taughtSince(login: string, userId: number, sinceIso: string): Promise<number> {
    const q = `repo:${this.org}/${this.repo} is:pr in:body "Taught-by: ${login} (${userId})" created:>=${sinceIso}`;
    const r = await this.call<{ total_count: number }>("GET", `/search/issues?q=${encodeURIComponent(q)}&per_page=1`);
    return r.total_count;
  }
}

export interface TeachRequest {
  subject: string;
  id: string;
  path: string;
  fileText: string;
  commitMessage: string;
  title: string;
  body: string;
  authorName: string;
  authorEmail: string;
}

/**
 * Branch, commit, PR, label. If any call after the branch exists fails, delete the branch and throw:
 * the request then did nothing (worker.md, POST /api/teach step 6).
 */
export async function openTeachingPr(repo: Repo, t: TeachRequest): Promise<{ number: number; html_url: string }> {
  const main = await repo.call<{ object: { sha: string } }>("GET", `${repo.base}/git/ref/heads/main`);
  const branch = `teach/${t.subject}/${t.id}`;
  await repo.call("POST", `${repo.base}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha });
  try {
    await repo.call("PUT", `${repo.base}/contents/${t.path}`, {
      message: t.commitMessage,
      content: base64Utf8(t.fileText),
      branch,
      author: { name: t.authorName, email: t.authorEmail },
    });
    const pr = await repo.call<{ number: number; html_url: string }>("POST", `${repo.base}/pulls`, { title: t.title, head: branch, base: "main", body: t.body });
    await repo.call("POST", `${repo.base}/issues/${pr.number}/labels`, { labels: ["lesson"] });
    return pr;
  } catch (err) {
    await repo.call("DELETE", `${repo.base}/git/refs/heads/${branch}`, undefined, [204]).catch(() => {});
    throw err;
  }
}

function base64Utf8(text: string): string {
  let s = "";
  for (const b of encoder.encode(text)) s += String.fromCharCode(b);
  return btoa(s);
}

export type PrStatus = "verified" | "closed" | "failed" | "checking";

/** merged → verified; closed unmerged → closed; any failed check run on the head → failed; else checking. */
export async function prStatus(repo: Repo, number: number): Promise<{ status: PrStatus; html_url: string; merged_at: string | null }> {
  const pr = await repo.call<{ merged_at: string | null; state: string; html_url: string; head: { sha: string } }>("GET", `${repo.base}/pulls/${number}`);
  if (pr.merged_at) return { status: "verified", html_url: pr.html_url, merged_at: pr.merged_at };
  if (pr.state === "closed") return { status: "closed", html_url: pr.html_url, merged_at: null };
  const runs = await repo.call<{ check_runs: { conclusion: string | null }[] }>("GET", `${repo.base}/commits/${pr.head.sha}/check-runs?per_page=100`);
  const failed = runs.check_runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled" || r.conclusion === "action_required");
  return { status: failed ? "failed" : "checking", html_url: pr.html_url, merged_at: null };
}
