/*
 * Impure data access for the dashboard: the client-side SavingsLedger reads
 * (§1 — these never leave the device) and the two read-only 2a endpoints
 * (/api/me for identity, /api/config for the saved non-secret config). No
 * decision or savings data is ever POSTed anywhere — the dashboard is a local
 * reader. Pure shaping lives in shape.ts.
 */
import { SavingsLedger } from "ludion-router/savings";
import type { SavingsSummary } from "ludion-router/savings";
import { createStorageConfigSource, writeDropinConfig } from "ludion-router";
import type { StoredConfig } from "ludion-workspace/schema";
import type { Snapshot } from "./shape";
import type { ProjectAggregate } from "./project";
import { assembleDropinConfig, type ProbeOutcome } from "./setup";

/**
 * Dogfood project wiring for the Overview "Project" scope. The collector returns
 * a content-free per-project aggregate; this is a read-only opt-in view, not a
 * write. Per-dev projectId provisioning is a later step — for now this is a
 * single hardcoded dogfood target (matches chat-test.html's telemetry config).
 */
export const DOGFOOD_PROJECT = {
  projectId: "ludion-dogfood-1",
  collectorUrl: "https://ludion-collector.ludion.workers.dev",
} as const;

export interface Identity {
  login: string;
  uid: string;
}

const ledger = new SavingsLedger();

/** Raw ledger view for per-model / success / recent derivations. Local only. */
export function readSnapshot(): Snapshot {
  return ledger.snapshot();
}

/** Cumulative savings summary. Local only. */
export function readSummary(): SavingsSummary {
  return ledger.summary();
}

/**
 * GET /api/me — the auth gate and the avatar source. Returns the identity when
 * authenticated, or null on 401. Throws on any other failure (so the shell can
 * show an honest error rather than silently redirecting on a transient blip).
 */
export async function fetchIdentity(): Promise<Identity | null> {
  const res = await fetch("/api/me", { headers: { accept: "application/json" } });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me ${res.status}`);
  return (await res.json()) as Identity;
}

/** GET /api/config — the saved non-secret config. Null on 401. */
export async function fetchConfig(): Promise<StoredConfig | null> {
  const res = await fetch("/api/config", { headers: { accept: "application/json" } });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/config ${res.status}`);
  return (await res.json()) as StoredConfig;
}

/**
 * PUT /api/config — persist the non-secret config (2b-2a Models/Relay writes).
 * The payload carries ONLY { config_version, fallback:{baseURL,model}, relayUrl }
 * — never the relay token (StoredConfig has no field for it, and the server
 * re-validates). Returns the server's stored shape.
 */
export async function putConfig(config: StoredConfig): Promise<StoredConfig> {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`PUT /api/config ${res.status}`);
  return (await res.json()) as StoredConfig;
}

/**
 * GET <collector>/v1/aggregate?projectId=<id> — the central collector's
 * content-free per-project aggregate (the "Project" scope). Read-only: the
 * dashboard never POSTs decisions here, it only reads the opted-in rollup. No
 * admin token; the endpoint is public derived data.
 */
export async function fetchProjectAggregate(
  collectorUrl: string,
  projectId: string,
): Promise<ProjectAggregate> {
  const base = collectorUrl.trim().replace(/\/+$/, "");
  const url = `${base}/v1/aggregate?projectId=${encodeURIComponent(projectId)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`aggregate ${res.status}`);
  return (await res.json()) as ProjectAggregate;
}

/** Read the client-only relay token from the persisted drop-in config. */
export function readRelayToken(): string | null {
  const cfg = createStorageConfigSource().get();
  const token = cfg?.fallback?.apiKey;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Mirror the assembled client `ludion.config.v1` into localStorage so the
 * drop-in router uses it on the next request. The token stays here, in the
 * browser, and is NEVER sent to a Ludion server (§5).
 */
export function syncDropinConfig(config: StoredConfig | null, token: string | null): void {
  writeDropinConfig(assembleDropinConfig(config, token));
}

const RELAY_PROVIDER_KEY = "ludion.relay.provider";

/**
 * The provider the relay was last set up for (§4.2). Client-only: it tracks the
 * deployed relay's upstream so a later fallback-provider switch can warn. It is
 * never a server field and never sent server-ward.
 */
export function readRelaySetupProvider(): string | null {
  try {
    const v = localStorage.getItem(RELAY_PROVIDER_KEY);
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeRelaySetupProvider(provider: string): void {
  try {
    localStorage.setItem(RELAY_PROVIDER_KEY, provider);
  } catch {
    /* storage unavailable — the mismatch warning simply will not show. */
  }
}

/**
 * Verify a deployed relay end to end from the browser (§2.1). Two probes against
 * the dev's own relay:
 *  1. a no-token POST — expect 401, proving the token gate is live;
 *  2. a token-authed POST with a 1-token completion — the cheapest call that
 *     exercises token + upstream + provider key together.
 * The provider key is never involved here; only the relay token (client-side
 * already) is sent. A thrown fetch is classified as CORS (relay reachable but
 * origin refused) vs unreachable using an opaque no-cors reachability check, so
 * the caller can name the right fix. No provider spend beyond one minimal token.
 */
export async function probeRelay(
  relayUrl: string,
  token: string,
  probeModel: string,
): Promise<ProbeOutcome> {
  const base = relayUrl.trim().replace(/\/+$/, "");
  const endpoint = `${base}/chat/completions`;

  const reachable = async (): Promise<boolean> => {
    try {
      // Opaque: resolves if the host responded at all, rejects only on a real
      // network/DNS failure. Lets us tell CORS-refusal apart from unreachable.
      await fetch(base, { mode: "no-cors" });
      return true;
    } catch {
      return false;
    }
  };

  let noTokenStatus: number;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    noTokenStatus = res.status;
  } catch {
    return (await reachable()) ? { kind: "cors" } : { kind: "unreachable" };
  }

  let authRes: Response;
  try {
    authRes = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
  } catch {
    return (await reachable()) ? { kind: "cors" } : { kind: "unreachable" };
  }

  if (authRes.status === 401) return { kind: "token_mismatch" };
  if (authRes.ok) return noTokenStatus === 401 ? { kind: "connected" } : { kind: "connected_open" };
  return { kind: "upstream_error", status: authRes.status };
}
