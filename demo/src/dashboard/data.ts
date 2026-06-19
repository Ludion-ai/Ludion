/*
 * Impure data access for the dashboard: the client-side SavingsLedger reads
 * (§1 — these never leave the device) and the two read-only 2a endpoints
 * (/api/me for identity, /api/config for the saved non-secret config). No
 * decision or savings data is ever POSTed anywhere — the dashboard is a local
 * reader. Pure shaping lives in shape.ts.
 */
import { SavingsLedger } from "ludion-router/savings";
import type { SavingsSummary } from "ludion-router/savings";
import type { StoredConfig } from "ludion-workspace/schema";
import type { Snapshot } from "./shape";

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

/** GET /api/config — read-only here (editing is 2b-2). Null on 401. */
export async function fetchConfig(): Promise<StoredConfig | null> {
  const res = await fetch("/api/config", { headers: { accept: "application/json" } });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/config ${res.status}`);
  return (await res.json()) as StoredConfig;
}
