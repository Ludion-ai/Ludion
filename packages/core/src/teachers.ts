export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const USER_AGENT = "LudionBot/0.1 (+https://ludion.ai/bot)";

function isRateLimited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
}

/**
 * Current login for each GitHub user id, via GET /user/{account_id}.
 * Ids that cannot be looked up are left out; callers fall back to the stored login.
 * Stops asking once GitHub says the rate limit is used up.
 */
export async function resolveLogins(ids: Iterable<number>, fetchFn: FetchFn, token?: string): Promise<Map<number, string>> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const logins = new Map<number, string>();
  for (const id of new Set(ids)) {
    let res: Response;
    try {
      res = await fetchFn(`https://api.github.com/user/${id}`, { headers });
    } catch {
      continue;
    }
    if (isRateLimited(res)) break;
    if (!res.ok) continue;
    const body = (await res.json()) as { login?: unknown; id?: unknown };
    if (typeof body.login === "string" && body.id === id) logins.set(id, body.login);
  }
  return logins;
}
