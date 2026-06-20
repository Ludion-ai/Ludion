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
import { assembleDropinConfig } from "./setup";

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
