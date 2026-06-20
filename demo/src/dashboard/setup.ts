/*
 * Pure shapers for the Models + Relay setup flow (Workspace 2b-2a). Everything
 * here is a deterministic transform over the static registry, the read-only
 * StoredConfig, and a client-only relay token — no DOM, no network, no storage
 * (those live in data.ts / the screen modules). Unit-tested in setup.test.ts.
 *
 * KEY DISTINCTION (the §0 ruling): there are two different base URLs.
 *  - UPSTREAM_BASE_URL — the provider's OpenAI-compatible endpoint. It lives ONLY
 *    in the deployed Worker's env (server-side). Derived from `provider` here
 *    because the registry carries no per-model base URL.
 *  - the client config's `fallback.baseURL` — the deployed RELAY url. The browser
 *    fetches the relay, never the provider directly (that is the relay's point
 *    and §5). So the provider upstream never enters the client config.
 */
import { listModels } from "ludion-router/registry";
import type { ModelEntry } from "ludion-router/registry";
import type { LudionDropinConfig } from "ludion-router";
import type { StoredConfig } from "ludion-workspace/schema";

/** The one import-line swap that routes existing OpenAI code through Ludion. */
export const IMPORT_LINE = "import OpenAI from 'https://esm.run/ludion-router/openai'";

/** The public relay template repo Lattice mirrors relay-template/ to. */
export const RELAY_TEMPLATE_REPO = "https://github.com/Ludion-ai/ludion-relay-template";

/**
 * The verified "Deploy to Cloudflare" button target for the relay template.
 * The button URL takes only `url=<repo>`; it cannot pre-fill per-dev var values
 * (confirmed against current docs, §0), so non-secret defaults live in the
 * template's wrangler.jsonc and the workspace only tells the dev what to change.
 */
export const DEPLOY_BUTTON_URL = `https://deploy.workers.cloudflare.com/?url=${RELAY_TEMPLATE_REPO}`;

/**
 * The relay template's baked-in defaults. UPSTREAM_BASE_URL defaults to the most
 * common verified provider so the common case needs no typing; ALLOWED_ORIGINS
 * defaults to the playground so the §2.1 auto-verify probe works on first deploy.
 * Both must stay in sync with relay-template/wrangler.jsonc.
 */
export const TEMPLATE_DEFAULT_UPSTREAM = "https://api.openai.com/v1";
export const PLAYGROUND_ORIGIN = "https://ludion.ai";

/**
 * Provider -> OpenAI-compatible upstream base URL for the Worker's
 * UPSTREAM_BASE_URL. OpenAI's is the verified default (matches the router's
 * DEFAULT_BASE_URL). Anthropic's is a best-known PASTE-POINT default the dev
 * confirms in wrangler.toml — NOT asserted as verified (see README warning).
 */
export const PROVIDER_UPSTREAM: Record<string, { url: string; verified: boolean }> = {
  openai: { url: "https://api.openai.com/v1", verified: true },
  anthropic: { url: "https://api.anthropic.com/v1", verified: false },
};

export interface FallbackModels {
  /** api models whose provider_model_id is verified — selectable as fallback. */
  selectable: ModelEntry[];
  /** api models pending verification — shown, withheld from selection. */
  unverified: ModelEntry[];
  /** on-device (local) models — informational/read-only here. */
  local: ModelEntry[];
}

/** Partition the registry into the three groups the Models section renders. */
export function fallbackModels(): FallbackModels {
  const api = listModels({ kind: "api" });
  return {
    selectable: api.filter((m) => m.provider_model_id_verified === true),
    unverified: api.filter((m) => m.provider_model_id_verified !== true),
    local: listModels({ kind: "local" }),
  };
}

/** The provider upstream entry for a model, or null when the provider is unknown. */
export function upstreamFor(model: ModelEntry | undefined): { url: string; verified: boolean } | null {
  if (!model) return null;
  return PROVIDER_UPSTREAM[model.provider] ?? null;
}

/**
 * UPSTREAM_BASE_URL guidance for a fallback model (§3.3). A mapped provider
 * yields its OpenAI-compatible base URL; an unmapped one yields no URL and a
 * generic instruction — never a guessed value.
 */
export function upstreamGuidance(model: ModelEntry | undefined): {
  url: string | null;
  verified: boolean;
  note: string;
} {
  const u = upstreamFor(model);
  if (!u) {
    return { url: null, verified: false, note: "Set this to your provider's OpenAI-compatible base URL." };
  }
  if (!u.verified) {
    return {
      url: u.url,
      verified: false,
      note: "Confirm this points at the provider's OpenAI-compatible endpoint, not its native API.",
    };
  }
  return { url: u.url, verified: true, note: "" };
}

/**
 * Suggested ALLOWED_ORIGINS (§3.4): the dev's own app origin plus the Ludion
 * playground origin, so testing from this workspace also clears the origin check.
 */
export function allowedOriginsSuggestion(appOrigin: string): string {
  return appOrigin === PLAYGROUND_ORIGIN ? PLAYGROUND_ORIGIN : `${appOrigin},${PLAYGROUND_ORIGIN}`;
}

/** True when a fallback model's upstream matches the template default (no typing needed). */
export function upstreamMatchesDefault(model: ModelEntry | undefined): boolean {
  return upstreamFor(model)?.url === TEMPLATE_DEFAULT_UPSTREAM;
}

/** The deployed Worker URL the dev pastes back must be an https URL. */
export function isProbableWorkerUrl(url: string): boolean {
  return /^https:\/\/\S+$/i.test(url.trim());
}

/**
 * The outcome of the paste-back auto-verify probes (§2.1). Network access lives
 * in data.ts; this is the pure result type so the message mapping is testable.
 *  - connected: token gate live AND the token-authed call resolved end-to-end.
 *  - connected_open: end-to-end works but the no-token probe was not rejected
 *    (RELAY_OPEN is likely set, leaving the key ungated).
 *  - token_mismatch: the authed probe got 401 — stored token != deployed token.
 *  - upstream_error: the relay reached the upstream and it returned non-2xx
 *    (wrong UPSTREAM_BASE_URL or a bad provider key).
 *  - cors: the relay was reachable but refused this origin.
 *  - unreachable: the URL did not respond.
 *  - invalid_url: the pasted value is not an https URL.
 */
export type ProbeOutcome =
  | { kind: "connected" }
  | { kind: "connected_open" }
  | { kind: "token_mismatch" }
  | { kind: "upstream_error"; status: number }
  | { kind: "cors" }
  | { kind: "unreachable" }
  | { kind: "invalid_url" };

export interface ProbeMessage {
  ok: boolean;
  text: string;
}

/** Map a probe outcome to an actionable status line (§2.1: name the cause + fix). */
export function describeProbe(outcome: ProbeOutcome): ProbeMessage {
  switch (outcome.kind) {
    case "connected":
      return { ok: true, text: "Relay connected. The token gate is live and the upstream resolved end to end." };
    case "connected_open":
      return {
        ok: false,
        text: "Relay reachable and the upstream resolved, but the no-token probe was not rejected. Your key is ungated — remove RELAY_OPEN from the relay and redeploy.",
      };
    case "token_mismatch":
      return {
        ok: false,
        text: "Token mismatch. The relay returned 401: its RELAY_TOKEN does not match the token above. Re-enter the token in Cloudflare, or regenerate and redeploy.",
      };
    case "upstream_error":
      return {
        ok: false,
        text: `Upstream returned ${outcome.status}. Check UPSTREAM_BASE_URL points at your provider's OpenAI-compatible endpoint and that PROVIDER_API_KEY is valid.`,
      };
    case "cors":
      return {
        ok: false,
        text: `Reached the relay, but it refused this origin. Add ${PLAYGROUND_ORIGIN} to ALLOWED_ORIGINS in your relay and redeploy.`,
      };
    case "unreachable":
      return {
        ok: false,
        text: "Could not reach that URL. Confirm it is the deployed Worker URL (https), then verify again.",
      };
    case "invalid_url":
      return { ok: false, text: "Enter the deployed Worker URL. It must start with https://." };
  }
}

/**
 * True when the relay was set up for a different provider than the current
 * fallback (§4.2). Both sides must be known to flag a mismatch.
 */
export function relayProviderMismatch(setupProvider: string | null, currentProvider: string | null): boolean {
  return setupProvider !== null && currentProvider !== null && setupProvider !== currentProvider;
}

/** True once a relay URL is recorded — drives the Relay status + assembly. */
export function relayDeployed(config: StoredConfig | null): boolean {
  return typeof config?.relayUrl === "string" && config.relayUrl.length > 0;
}

/** The relay URL the client routes through (relayUrl, or the stored baseURL). */
export function relayBaseUrl(config: StoredConfig | null): string | undefined {
  return config?.relayUrl ?? config?.fallback?.baseURL ?? undefined;
}

/**
 * Assemble the client `ludion.config.v1` the developer drops in: the server's
 * non-secret fields PLUS the client-only relay token as `fallback.apiKey`. The
 * token is added HERE, client-side, and never travels server-ward (§5).
 */
export function assembleDropinConfig(
  config: StoredConfig | null,
  token: string | null,
): LudionDropinConfig {
  const model = config?.fallback?.model;
  const baseURL = relayBaseUrl(config);
  const fallback: NonNullable<LudionDropinConfig["fallback"]> = {};
  if (baseURL !== undefined) fallback.baseURL = baseURL;
  if (model !== undefined) fallback.model = model;
  if (token !== null && token.length > 0) fallback.apiKey = token;
  return { config_version: 1, fallback };
}

/**
 * The exact StoredConfig payload `PUT /api/config` receives. Built from
 * non-secret fields only — there is no field that could carry the token, and
 * the server re-validates (schema.ts) regardless. Used by the screens and
 * asserted token-free in the privacy test.
 */
export function toStoredPayload(
  config: StoredConfig | null,
  patch: { model?: string; relayUrl?: string; baseURL?: string },
): StoredConfig {
  const fallback: StoredConfig["fallback"] = { ...(config?.fallback ?? {}) };
  if (patch.model !== undefined) fallback.model = patch.model;
  if (patch.baseURL !== undefined) fallback.baseURL = patch.baseURL;
  const out: StoredConfig = { config_version: 1, fallback };
  const relayUrl = patch.relayUrl ?? config?.relayUrl;
  if (relayUrl !== undefined) out.relayUrl = relayUrl;
  return out;
}

/** Generate a 256-bit client-side relay token (hex). Never sent to Ludion. */
export function generateRelayToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The wrangler.toml [vars] block the dev pastes, filled for their setup. */
export function wranglerVars(upstreamBaseURL: string, allowedOrigin: string): string {
  return [
    "[vars]",
    `UPSTREAM_BASE_URL = "${upstreamBaseURL}"`,
    `ALLOWED_ORIGINS = "${allowedOrigin}"`,
  ].join("\n");
}

/** The deploy commands, in order. The token is set as a Worker secret. */
export function deploySteps(): Array<{ cmd: string; note: string }> {
  return [
    { cmd: "npx wrangler secret put PROVIDER_API_KEY", note: "your real provider key — server-side only, never the browser" },
    { cmd: "npx wrangler secret put RELAY_TOKEN", note: "paste the generated token below — the relay's auth boundary" },
    { cmd: "npx wrangler deploy", note: "deploy from relays/cloudflare-worker/ in this repo" },
  ];
}
