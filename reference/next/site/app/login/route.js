import { createHash } from "node:crypto";

const html = (body) => new Response(`<!doctype html><html lang="en"><head><title>Log in · Reference Shop</title></head><body>${body}</body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } });

export function GET() {
  return html('<form method="post" action="/login"><input name="user"><input name="password" type="password"><button>Log in</button></form>');
}

export async function POST(request) {
  const form = await request.formData();
  const user = form.get("user"), password = form.get("password");
  if (!user || !password) return html("<p>Missing credentials</p>");
  const session = createHash("sha256").update(`reference:${user}`).digest("base64url").slice(0, 22);
  return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": `session=${session}; Path=/; HttpOnly; SameSite=Lax` } });
}
