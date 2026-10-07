// Test harness for the Worker: real bindings from wrangler.jsonc (ASSETS over the built site, the rate limiter),
// test secrets, and a fake outbound fetch that plays GitHub and source pages.
import { env as bindings } from "cloudflare:workers";
import { createApp, type Env } from "../src/app.ts";
import { sign, type Session } from "../src/session.ts";

export const SITE = "https://ludion.ai";

function toPem(der: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(der)) s += String.fromCharCode(b);
  const b64 = btoa(s).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

let pem: Promise<string> | undefined;
function appPrivateKey(): Promise<string> {
  return (pem ??= crypto.subtle
    .generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    .then((k) => crypto.subtle.exportKey("pkcs8", (k as CryptoKeyPair).privateKey))
    .then((der) => toPem(der as ArrayBuffer)));
}

export const SESSION_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256)));

export async function testEnv(): Promise<Env> {
  const b = bindings as unknown as Env;
  return {
    ASSETS: b.ASSETS,
    SOURCE_CHECK_LIMITER: b.SOURCE_CHECK_LIMITER,
    SITE_URL: SITE,
    GITHUB_APP_ID: "1001",
    GITHUB_APP_INSTALLATION_ID: "2002",
    GITHUB_APP_PRIVATE_KEY: await appPrivateKey(),
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
  };
}

export interface Call {
  method: string;
  url: string;
  body?: any;
  headers: Headers;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** A fake outbound fetch: routes by "METHOD url-prefix", records every call, 404 for anything unrouted. */
export class FakeNet {
  calls: Call[] = [];
  private routes: [string, Handler][] = [];

  on(key: string, handler: Handler): this {
    this.routes.unshift([key, handler]);
    return this;
  }

  fetch = async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const call: Call = { method: req.method, url: req.url, body, headers: req.headers };
    this.calls.push(call);
    for (const [key, handler] of this.routes) {
      const [method, prefix] = key.split(" ");
      if (req.method === method && req.url.startsWith(prefix!)) return handler(call);
    }
    return new Response("not routed in the test", { status: 404 });
  };

  find(method: string, prefix: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.url.startsWith(prefix));
  }
}

const REPO = "https://api.github.com/repos/Ludion-ai/ludion";

/** A GitHub that accepts a teaching PR, with `taught` PRs already in the last 24 hours. */
export function github(net: FakeNet, taught = 0): FakeNet {
  return net
    .on("POST https://api.github.com/app/installations/2002/access_tokens", () =>
      Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 }),
    )
    .on("GET https://api.github.com/search/issues", () => Response.json({ total_count: taught, items: [] }))
    .on(`GET ${REPO}/git/ref/heads/main`, () => Response.json({ object: { sha: "mainsha" } }))
    .on(`POST ${REPO}/git/refs`, () => Response.json({ ref: "x" }, { status: 201 }))
    .on(`PUT ${REPO}/contents/`, () => Response.json({ content: {} }, { status: 201 }))
    .on(`POST ${REPO}/pulls`, () => Response.json({ number: 42, html_url: "https://github.com/Ludion-ai/ludion/pull/42" }, { status: 201 }))
    .on(`POST ${REPO}/issues/42/labels`, () => Response.json([{ name: "lesson" }]))
    .on(`DELETE ${REPO}/git/refs/heads/`, () => new Response(null, { status: 204 }));
}

/** A source page that contains `quote`. */
export function page(net: FakeNet, url: string, html: string, status = 200): FakeNet {
  return net.on(`GET ${url}`, () => new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }));
}

let nextUser = 5000;
export function newUser(overrides: Partial<Session> = {}): Session {
  const id = nextUser++;
  return { login: `teacher${id}`, id, avatar_url: `https://avatars.githubusercontent.com/u/${id}`, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides };
}

export async function sessionCookie(session: Session): Promise<string> {
  return `ludion_session=${await sign(session, SESSION_SECRET)}`;
}

export const ctx = (): ExecutionContext =>
  ({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

/** Run one request through a fresh app wired to `net`. */
export async function request(net: FakeNet, path: string, init: RequestInit = {}, now = () => Date.now()): Promise<Response> {
  const app = createApp({ fetch: net.fetch, now });
  return app.request(`${SITE}${path}`, init, await testEnv(), ctx());
}

/** A same-origin JSON POST, signed in as `session` (or anonymous). */
export async function post(net: FakeNet, path: string, body: unknown, session?: Session, headers: Record<string, string> = {}): Promise<Response> {
  return request(net, path, {
    method: "POST",
    headers: {
      Origin: SITE,
      "Content-Type": "application/json",
      ...(session ? { Cookie: await sessionCookie(session) } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
