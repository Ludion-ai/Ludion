/*
 * Workspace dashboard entry (2b-1). Auth-gates on the 2a session, then mounts
 * the shell. The whole workspace requires a valid session: GET /api/me returns
 * 401 (or is unreachable) → redirect to /auth/login.
 *
 * The only exception is a LOCAL design preview under `vite dev` (where the
 * Pages Functions aren't running), gated behind import.meta.env.DEV — which
 * Vite compiles OUT of the production build, so the deployed artifact always
 * enforces the strict redirect.
 */
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./dashboard.css";
import { fetchConfig, fetchIdentity, type Identity } from "./dashboard/data";
import { mountShell } from "./dashboard/shell";

const root = document.getElementById("lx-root");
if (!root) throw new Error("missing #lx-root");

async function resolveIdentity(): Promise<Identity | null> {
  // null = unauthenticated (401) or backend unreachable; either way, no session.
  try {
    return await fetchIdentity();
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const identity = await resolveIdentity();
  if (!identity) {
    if (import.meta.env.DEV) {
      // Local design preview only (compiled out of `vite build`). Real device
      // ledger still drives the cards; config is treated as empty.
      mountShell({ root: root!, identity: { login: "dev", uid: "0" }, config: null });
      return;
    }
    window.location.href = "/auth/login";
    return;
  }
  const config = await fetchConfig().catch(() => null);
  mountShell({ root: root!, identity, config });
}

void boot();
