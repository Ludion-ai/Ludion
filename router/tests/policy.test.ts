import { describe, expect, it } from "vitest";
import type { RouterProbe } from "@entelic/shared";
import { POLICY_V0 } from "../src/index";
import type { RequestFacts } from "../src/policy";
import { evaluatePolicy } from "../src/policy";

const probe = (over: Partial<RouterProbe> = {}): RouterProbe => ({
  ua: "test",
  webgpu: true,
  adapter: { vendor: "test", architecture: "test", f16: true, maxBufferSize: 1 << 30 },
  hw_concurrency: 8,
  device_memory_gb: null,
  env: "browser",
  os_class: "desktop",
  ...over,
});

const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  est_prompt_tokens: 50,
  max_tokens: 128,
  stream: true,
  privacy: false,
  ...over,
});

describe("policy v0 determinism table (acceptance 7: all 6 rules)", () => {
  const cases: Array<{
    name: string;
    probe: RouterProbe;
    facts: RequestFacts;
    struck?: boolean;
    expect: { target: "local" | "server"; rule_id: string };
  }> = [
    {
      name: "R1: IAB → server even on capable hardware (IAB does not hide WebGPU)",
      probe: probe({ env: "webview-iab", os_class: "android-chromium" }),
      facts: facts(),
      expect: { target: "server", rule_id: "R1" },
    },
    {
      name: "R2: no WebGPU → server",
      probe: probe({ webgpu: false, adapter: null }),
      facts: facts(),
      expect: { target: "server", rule_id: "R2" },
    },
    {
      name: "R3: ios-webkit → server even with WebGPU",
      probe: probe({ os_class: "ios-webkit" }),
      facts: facts(),
      expect: { target: "server", rule_id: "R3" },
    },
    {
      name: "R4: desktop + WebGPU → local",
      probe: probe(),
      facts: facts(),
      expect: { target: "local", rule_id: "R4" },
    },
    {
      name: "R4 KV guard (B-4): est > 3000 falls through to R6",
      probe: probe(),
      facts: facts({ est_prompt_tokens: 3001 }),
      expect: { target: "server", rule_id: "R6" },
    },
    {
      name: "R5: Android short streaming prompt → local",
      probe: probe({ os_class: "android-chromium" }),
      facts: facts({ est_prompt_tokens: 52, max_tokens: 256 }),
      expect: { target: "local", rule_id: "R5" },
    },
    {
      name: "R5 boundary: 200 tokens passes, 201 falls to R6 (acceptance 3)",
      probe: probe({ os_class: "android-chromium" }),
      facts: facts({ est_prompt_tokens: 200 }),
      expect: { target: "local", rule_id: "R5" },
    },
    {
      name: "R5 fail at 201 tokens → R6",
      probe: probe({ os_class: "android-chromium" }),
      facts: facts({ est_prompt_tokens: 201 }),
      expect: { target: "server", rule_id: "R6" },
    },
    {
      name: "R5 fail: max_tokens > 256 → R6",
      probe: probe({ os_class: "android-chromium" }),
      facts: facts({ max_tokens: 512 }),
      expect: { target: "server", rule_id: "R6" },
    },
    {
      name: "R5: absent max_tokens uses policy default 256 (passes)",
      probe: probe({ os_class: "android-chromium" }),
      facts: facts({ max_tokens: null }),
      expect: { target: "local", rule_id: "R5" },
    },
    {
      name: "Q6: Android stream:false is gated → R6 (26s silent block is perceived failure)",
      probe: probe({ os_class: "android-chromium" }),
      facts: facts({ stream: false }),
      expect: { target: "server", rule_id: "R6" },
    },
    {
      name: "R6: unknown os_class routes safe",
      probe: probe({ os_class: "other" }),
      facts: facts(),
      expect: { target: "server", rule_id: "R6" },
    },
    {
      name: "strike short-circuit: struck model on desktop → server (R4+strike)",
      probe: probe(),
      facts: facts(),
      struck: true,
      expect: { target: "server", rule_id: "R4+strike" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const d = evaluatePolicy(POLICY_V0, c.probe, c.facts, c.struck ?? false);
      expect(d).toEqual({ kind: "route", ...c.expect });
    });
  }

  it("same inputs → same decision (no clock/randomness)", () => {
    const p = probe({ os_class: "android-chromium" });
    const f = facts({ est_prompt_tokens: 200 });
    expect(evaluatePolicy(POLICY_V0, p, f, false)).toEqual(evaluatePolicy(POLICY_V0, p, f, false));
  });
});

describe("privacy evaluation (B-1 / B-2)", () => {
  it("B-1: privacy forces local when only request conditions fail (Android @ 201 tok)", () => {
    const d = evaluatePolicy(
      POLICY_V0,
      probe({ os_class: "android-chromium" }),
      facts({ est_prompt_tokens: 201, privacy: true }),
      false,
    );
    expect(d).toEqual({ kind: "route", target: "local", rule_id: "R5+privacy" });
  });

  it("privacy with fully matching local rule keeps the plain rule_id", () => {
    const d = evaluatePolicy(POLICY_V0, probe(), facts({ privacy: true }), false);
    expect(d).toEqual({ kind: "route", target: "local", rule_id: "R4" });
  });

  it("privacy on iOS → unroutable, never server (acceptance 5)", () => {
    const d = evaluatePolicy(
      POLICY_V0,
      probe({ os_class: "ios-webkit" }),
      facts({ privacy: true }),
      false,
    );
    expect(d.kind).toBe("privacy-unroutable");
    if (d.kind === "privacy-unroutable") expect(d.rule_id).toBe("R3");
  });

  it("privacy without WebGPU → unroutable via R2", () => {
    const d = evaluatePolicy(
      POLICY_V0,
      probe({ webgpu: false, adapter: null }),
      facts({ privacy: true }),
      false,
    );
    expect(d.kind).toBe("privacy-unroutable");
  });

  it("privacy in IAB → unroutable via R1", () => {
    const d = evaluatePolicy(
      POLICY_V0,
      probe({ env: "webview-iab" }),
      facts({ privacy: true }),
      false,
    );
    expect(d.kind).toBe("privacy-unroutable");
    if (d.kind === "privacy-unroutable") expect(d.rule_id).toBe("R1");
  });

  it("B-2: privacy × struck model → unroutable (forcing local would kill the tab)", () => {
    const d = evaluatePolicy(POLICY_V0, probe(), facts({ privacy: true }), true);
    expect(d).toEqual({
      kind: "privacy-unroutable",
      rule_id: "R4+strike",
      reason: expect.stringContaining("struck"),
    });
  });
});
