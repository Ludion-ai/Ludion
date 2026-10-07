/** API JSON responses: `Content-Type: application/json; charset=utf-8` (worker.md, Cross-cutting). */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

/** Every error body is {error, message} plus fields. /api/check errors also carry ok:false. */
export function apiError(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, message, ...extra }, status);
}

export function getCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number, path = "/"): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

/** CSRF: same-origin JSON only (worker.md, Sign-in and session). */
export function csrfProblem(request: Request, siteUrl: string): "forbidden_origin" | "bad_request" | undefined {
  if (request.headers.get("Origin") !== new URL(siteUrl).origin) return "forbidden_origin";
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return "bad_request";
  return undefined;
}
