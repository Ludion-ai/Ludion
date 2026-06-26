/*
 * Demo-execution instrumentation (instrumentation spec).
 *
 * Records the lifecycle of the in-browser "run a tiny model" demo so we can
 * answer one question per device class: of the visitors who START the demo,
 * how many FINISH, how many FAIL, and how many go SILENT (tab-kill). The
 * tab-kill case (iPhone OOM) cannot be recorded directly — when the tab dies
 * JS dies with it — so it is inferred at analysis time by the ABSENCE of a
 * terminal event for a session that emitted demo_clicked.
 *
 * Hard rules (spec):
 *   - NO PII. We never send IP, user id, prompt text, model output, the precise
 *     UA string, or any fingerprint. Only the coarse fields below.
 *   - session_id lives in memory ONLY (a module-level variable). It is NOT
 *     persisted — no localStorage / sessionStorage / cookie. It resets on every
 *     page load and is meaningless across loads; it exists purely to correlate
 *     events within one page load.
 *   - Fire-and-forget. Every error is swallowed. The demo must keep working even
 *     if tracking is broken or the endpoint is down. No-op outside the browser.
 *   - Start events (demo_clicked, demo_model_loaded) go via sendBeacon so they
 *     survive a tab being torn down moments later; terminal events use
 *     fetch(keepalive:true).
 */

export type DemoEvent =
  | "demo_clicked"
  | "demo_model_loaded"
  | "demo_first_token"
  | "demo_finished"
  | "demo_failed";

// demo_failed reason vocabulary is fixed and non-PII (spec §"Fields per event").
export type DemoFailReason = "load_failed" | "runtime_error" | "routed_to_server";

const ENDPOINT = "/api/track";

// Start events must be delivered even if the page is torn down right after, so
// they use navigator.sendBeacon. Terminal events use fetch(keepalive:true).
const BEACON_EVENTS = new Set<DemoEvent>(["demo_clicked", "demo_model_loaded"]);

// Resolved once per page load, lazily on first track() call.
let sessionId: string | null = null;
let deviceClass: "mobile" | "desktop" | "unknown" | null = null;
let browser: string | null = null;

function inBrowser(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // Non-cryptographic fallback — only used to correlate within one page load.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Coarse device class. Prefer the UA-Client-Hints `mobile` boolean when the
// browser exposes it (no string parsing, no fingerprint); else a simple, well
// known UA substring check. Never builds a fingerprint.
function resolveDeviceClass(): "mobile" | "desktop" | "unknown" {
  try {
    const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
    if (uaData && typeof uaData.mobile === "boolean") {
      return uaData.mobile ? "mobile" : "desktop";
    }
    const ua = navigator.userAgent || "";
    if (!ua) return "unknown";
    return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? "mobile" : "desktop";
  } catch {
    return "unknown";
  }
}

// Coarse browser family only — no version string. Order matters: mobile_safari
// and firefox before the generic chrome/safari checks.
function resolveBrowser(): string {
  try {
    const ua = navigator.userAgent || "";
    if (/Firefox\//i.test(ua) || /FxiOS\//i.test(ua)) return "firefox";
    const isApple = /Safari\//i.test(ua) && !/Chrome|Chromium|CriOS|Edg/i.test(ua);
    if (isApple) return /iPhone|iPad|iPod/i.test(ua) ? "mobile_safari" : "safari";
    if (/Chrome|Chromium|CriOS/i.test(ua)) return "chrome";
    return "other";
  } catch {
    return "other";
  }
}

export function track(event: DemoEvent, extra?: { reason?: DemoFailReason }): void {
  // No-op in any non-browser context (SSR, tests, build).
  if (!inBrowser()) return;
  try {
    if (sessionId === null) sessionId = randomId();
    if (deviceClass === null) deviceClass = resolveDeviceClass();
    if (browser === null) browser = resolveBrowser();

    const payload: Record<string, string> = {
      event,
      session_id: sessionId,
      device_class: deviceClass,
      browser,
    };
    // reason only for demo_failed, fixed vocabulary, never free-form.
    if (event === "demo_failed" && extra?.reason) payload.reason = extra.reason;

    const body = JSON.stringify(payload);

    if (BEACON_EVENTS.has(event) && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(ENDPOINT, blob);
      if (ok) return;
      // sendBeacon can refuse (queue full); fall through to keepalive fetch.
    }

    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      // Same-origin only; never send credentials (no cookies anywhere here).
      credentials: "omit",
    }).catch(() => {
      /* swallow — tracking must never affect the demo */
    });
  } catch {
    /* swallow every error — the demo must never throw because tracking failed */
  }
}
