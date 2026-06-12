import { describe, expect, it } from "vitest";
import { autoPlan, classifyDevice, guessLabel } from "../src/plan";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
const REDUCED_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

describe("classifyDevice (decisions Q3)", () => {
  it("no WebGPU → no-webgpu, regardless of memory", () => {
    expect(classifyDevice({ webgpu: false, ua: DESKTOP_UA, device_memory_gb: 16 })).toBe(
      "no-webgpu",
    );
  });

  it("iOS WebKit → constrained even though device_memory_gb is null there", () => {
    expect(classifyDevice({ webgpu: true, ua: IPHONE_UA, device_memory_gb: null })).toBe(
      "constrained",
    );
  });

  it("low reported memory → constrained", () => {
    expect(classifyDevice({ webgpu: true, ua: PIXEL_UA, device_memory_gb: 4 })).toBe("constrained");
  });

  it("WebGPU + ample/unknown memory → standard", () => {
    expect(classifyDevice({ webgpu: true, ua: DESKTOP_UA, device_memory_gb: 8 })).toBe("standard");
    expect(classifyDevice({ webgpu: true, ua: DESKTOP_UA, device_memory_gb: null })).toBe(
      "standard",
    );
  });
});

describe("autoPlan", () => {
  it("standard: WebLLM × Llama-3.2-1B cold (matches existing comparable rows)", () => {
    const plan = autoPlan({ webgpu: true, ua: DESKTOP_UA, device_memory_gb: 8 });
    expect(plan).toMatchObject({
      deviceClass: "standard",
      engine: "webllm",
      modelKey: "llama-3.2-1b",
      cacheState: "cold",
    });
  });

  it("constrained: WebLLM × floor model (built to finish, not to tombstone)", () => {
    const plan = autoPlan({ webgpu: true, ua: IPHONE_UA, device_memory_gb: null });
    expect(plan).toMatchObject({ engine: "webllm", modelKey: "qwen2.5-0.5b" });
  });

  it("no-webgpu: wllama × floor model (WASM runs anywhere)", () => {
    const plan = autoPlan({ webgpu: false, ua: DESKTOP_UA, device_memory_gb: null });
    expect(plan).toMatchObject({ engine: "wllama", modelKey: "qwen2.5-0.5b" });
  });

  it("every class is cold + single session by construction", () => {
    for (const facts of [
      { webgpu: true, ua: DESKTOP_UA, device_memory_gb: 8 },
      { webgpu: true, ua: IPHONE_UA, device_memory_gb: null },
      { webgpu: false, ua: PIXEL_UA, device_memory_gb: 2 },
    ]) {
      expect(autoPlan(facts).cacheState).toBe("cold");
    }
  });
});

describe("guessLabel (spec §1-2)", () => {
  it("extracts Android model tokens", () => {
    expect(guessLabel(PIXEL_UA)).toBe("pixel-8a");
  });

  it("falls back on Chrome's reduced-UA 'K' model", () => {
    expect(guessLabel(REDUCED_ANDROID_UA)).toBe("android");
  });

  it("iOS has no model granularity in the UA", () => {
    expect(guessLabel(IPHONE_UA)).toBe("iphone");
  });

  it("desktop = os-browser sketch matching the results/ convention", () => {
    expect(guessLabel(DESKTOP_UA)).toBe("windows-chrome");
  });
});
