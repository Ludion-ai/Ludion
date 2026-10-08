// Teaching stays closed until every secret is set and well formed and the App's bot id is in ludion.config.json
// (worker.md, "Closed until ready"). Until then /api/* and /auth/* answer 503 and ludion_teach saves nothing.
import type { Env } from "./app.ts";
import { APP_BOT_ID } from "./config.ts";

export const NOT_OPEN = "Teaching on Ludion opens soon. Nothing was saved.";

export const PKCS1_KEY =
  "GITHUB_APP_PRIVATE_KEY is a PKCS#1 key (BEGIN RSA PRIVATE KEY), and Web Crypto needs PKCS#8. Convert it once with `openssl pkcs8 -topk8 -nocrypt -in ludion.private-key.pem -out ludion.pk8.pem` and store ludion.pk8.pem as GITHUB_APP_PRIVATE_KEY (worker.md, GitHub App).";

export const SHORT_SESSION_SECRET =
  "SESSION_SECRET must be at least 32 random bytes, base64. Make one with `openssl rand -base64 32` and store it as SESSION_SECRET.";

const SECRETS = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SESSION_SECRET"] as const;

/** SESSION_SECRET as key bytes: base64 if it decodes, else the text itself. */
export function sessionSecretBytes(secret: string): Uint8Array {
  try {
    return Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    return new TextEncoder().encode(secret);
  }
}

/** Why teaching is closed, for the log (names only, never values); undefined when it is open. */
export function teachingProblem(env: Partial<Env>, appBotId: number | undefined = APP_BOT_ID): string | undefined {
  const missing = SECRETS.filter((name) => !env[name]);
  if (missing.length > 0) return `Missing secrets: ${missing.join(", ")}.`;
  if (!Number.isInteger(appBotId) || appBotId! < 1) return "ludion.config.json has no app_bot_id (the Ludion App's bot account id).";
  if (sessionSecretBytes(env.SESSION_SECRET!).length < 32) return SHORT_SESSION_SECRET;
  if (env.GITHUB_APP_PRIVATE_KEY!.includes("BEGIN RSA PRIVATE KEY")) return PKCS1_KEY;
  return undefined;
}
