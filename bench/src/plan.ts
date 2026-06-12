import type { DeviceInfo, EngineId, CacheState } from "./schema";
import type { ModelKey } from "./models";

/**
 * Gate 2.7 one-click flow: the plan is auto-selected, deterministically, from
 * the probe (spec §1-1; per-class plans ruled in decisions Q3).
 *
 * Every class is a single session — the default flow never needs a
 * between-session reload. Boundary probing (1B/1.5B on constrained devices)
 * stays in Advanced: that is operator work, not stranger work.
 */

export type DeviceClass = "no-webgpu" | "constrained" | "standard";

export interface AutoPlan {
  deviceClass: DeviceClass;
  engine: EngineId;
  modelKey: ModelKey;
  cacheState: CacheState;
  /** Plain-words rationale shown on the page and logged. */
  reason: string;
}

type ProbeFacts = Pick<DeviceInfo, "webgpu" | "ua" | "device_memory_gb">;

export function classifyDevice(d: ProbeFacts): DeviceClass {
  if (!d.webgpu) return "no-webgpu";
  // device_memory_gb is null on iOS/Safari (Chrome-only API) — iOS detection
  // is UA-based. iPadOS 13+ masquerades as Macintosh; "Macintosh + touch" is
  // not probeable here, so a masquerading iPad lands in "standard" (accepted:
  // those are the high-memory iPads).
  if (/iPhone|iPad/i.test(d.ua)) return "constrained";
  if (d.device_memory_gb !== null && d.device_memory_gb <= 4) return "constrained";
  return "standard";
}

export function autoPlan(d: ProbeFacts): AutoPlan {
  const deviceClass = classifyDevice(d);
  switch (deviceClass) {
    case "no-webgpu":
      return {
        deviceClass,
        engine: "wllama",
        modelKey: "qwen2.5-0.5b",
        cacheState: "cold",
        reason: "no WebGPU here, so the CPU engine with the smallest model (379 MB)",
      };
    case "constrained":
      return {
        deviceClass,
        engine: "webllm",
        modelKey: "qwen2.5-0.5b",
        cacheState: "cold",
        reason: "limited memory, so the smallest model (265 MB) — built to finish",
      };
    case "standard":
      return {
        deviceClass,
        engine: "webllm",
        modelKey: "llama-3.2-1b",
        cacheState: "cold",
        reason: "standard plan (695 MB) — comparable with the published rows",
      };
  }
}

/**
 * UA-derived device label guess (spec §1-2). Prefill only; the user's edit
 * always wins. Lowercase-hyphenated to match the results/ naming convention.
 */
export function guessLabel(ua: string): string {
  const sanitize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

  if (/iPhone/i.test(ua)) return "iphone";
  if (/iPad/i.test(ua)) return "ipad";
  const android = /Android[^;)]*;\s*([^;)]+)/.exec(ua);
  if (android) {
    const model = android[1]!.trim();
    // Chrome's reduced UA sends the literal model "K" — carries no information.
    if (model.length > 1 && model.toLowerCase() !== "k") return sanitize(model);
    return "android";
  }
  const os = /Windows/i.test(ua)
    ? "windows"
    : /Macintosh/i.test(ua)
      ? "mac"
      : /CrOS/i.test(ua)
        ? "chromeos"
        : /Linux|X11/i.test(ua)
          ? "linux"
          : "desktop";
  const browser = /Edg\//.test(ua)
    ? "edge"
    : /Firefox\//.test(ua)
      ? "firefox"
      : /Chrome\//.test(ua)
        ? "chrome"
        : /Safari\//.test(ua)
          ? "safari"
          : "browser";
  return `${os}-${browser}`;
}
