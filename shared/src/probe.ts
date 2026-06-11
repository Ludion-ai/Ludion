/**
 * Router capability probe.
 *
 * INTENTIONAL DUPLICATION (Gate 1 decisions Q1): the WebGPU-adapter probing
 * here is a new-copy of `bench/src/capability.ts` — bench is NOT imported and
 * NOT modified, so Gate 0 measurement comparability is structurally
 * guaranteed. Keep divergence deliberate; cross-reference when editing.
 *
 * Gate 1 extensions over the bench probe:
 *  - `env`: in-app browser / WebView detection (policy R1).
 *  - `os_class`: ios-webkit | android-chromium | desktop | other (R3/R4/R5).
 *
 * Probing must never throw — failures degrade to conservative values
 * (no webgpu, env "browser", os_class "other"), which route to server.
 */

export type EnvClass = "browser" | "webview-iab";
export type OsClass = "ios-webkit" | "android-chromium" | "desktop" | "other";

export interface RouterAdapterInfo {
  vendor: string;
  architecture: string;
  f16: boolean;
  maxBufferSize: number;
}

export interface RouterProbe {
  ua: string;
  webgpu: boolean;
  adapter: RouterAdapterInfo | null;
  hw_concurrency: number;
  device_memory_gb: number | null;
  env: EnvClass;
  os_class: OsClass;
}

/** The navigator facts classification depends on — pure-function testable. */
export interface NavigatorFacts {
  ua: string;
  platform: string;
  maxTouchPoints: number;
}

/**
 * In-app-browser UA token list (Gate 1 decisions B-6).
 * Evidence note: IAB does NOT hide WebGPU — the archived LINE-IAB export
 * (Pixel 8a, 2026-06-10 12:43) shows `webgpu: true` with a fully visible
 * adapter. So R1 must catch IABs by UA, not rely on R2; UA-list misses are
 * accepted residual risk in v0, self-healed by the strike rule
 * (first stall → tombstone → strike → server).
 */
const IAB_UA_TOKENS: readonly RegExp[] = [
  /; wv\)/, // Android WebView marker
  /FB_IAB/,
  /FBAN|FBAV/,
  /Line\//,
  /Instagram/,
  /MicroMessenger/,
  /GSA\//, // Google app in-app browser
];

export function classifyEnv(ua: string): EnvClass {
  return IAB_UA_TOKENS.some((re) => re.test(ua)) ? "webview-iab" : "browser";
}

export function classifyOsClass(facts: NavigatorFacts): OsClass {
  if (/iPhone|iPad|iPod/.test(facts.ua)) return "ios-webkit";
  // A-3: iPadOS Safari masquerades as desktop Safari ("Macintosh" UA,
  // platform "MacIntel"). Real Macs never report >1 touch points.
  if (facts.platform === "MacIntel" && facts.maxTouchPoints > 1) return "ios-webkit";
  // All Android engines are classified android-chromium: non-Chromium Android
  // browsers have no WebGPU today, so R2 routes them to server anyway.
  if (/Android/.test(facts.ua)) return "android-chromium";
  if (/Windows NT|Macintosh|CrOS|Linux/.test(facts.ua)) return "desktop";
  return "other";
}

async function probeAdapter(): Promise<RouterAdapterInfo | null> {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return {
      vendor: adapter.info?.vendor ?? "",
      architecture: adapter.info?.architecture ?? "",
      f16: adapter.features.has("shader-f16"),
      maxBufferSize: adapter.limits.maxBufferSize,
    };
  } catch {
    return null;
  }
}

/**
 * Probe the current browser. Cached per Ludion instance (per page load) by
 * the router facade. Only touches `navigator.gpu.requestAdapter()` — never
 * imports WebLLM (Gate 1 decisions Q2).
 */
export async function probeRouterDevice(): Promise<RouterProbe> {
  const fallback: RouterProbe = {
    ua: "",
    webgpu: false,
    adapter: null,
    hw_concurrency: 0,
    device_memory_gb: null,
    env: "browser",
    os_class: "other",
  };
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const adapter = await probeAdapter();
    return {
      ua: navigator.userAgent,
      webgpu: adapter !== null,
      adapter,
      hw_concurrency: navigator.hardwareConcurrency ?? 0,
      device_memory_gb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
      env: classifyEnv(navigator.userAgent),
      os_class: classifyOsClass({
        ua: navigator.userAgent,
        platform: navigator.platform ?? "",
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
      }),
    };
  } catch {
    return fallback;
  }
}
