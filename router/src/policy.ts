import type { RouterProbe } from "@ludion/shared";

/**
 * Policy v0 interpreter — policy is DATA, not code (spec Section 5).
 * Rules are ordered; first match wins; deterministic: same
 * (probe, request facts, policy, struck flag) → same decision. No clock, no
 * randomness inside evaluation.
 *
 * Conditions are split into `hw` (hardware/environment class) and `request`
 * (request-shape) groups because privacy evaluation (B-1) only honors `hw`:
 * privacy is a declaration of secrecy over speed, so the only grounds for
 * refusing local are hardware conditions (R1/R2/R3 class). A privacy request
 * that fails only request conditions (e.g. Android @ 201 tok) is FORCED
 * local, recorded as `R5+privacy`.
 */

export type RouteTarget = "local" | "server";

export interface PolicyHwConditions {
  env?: string;
  webgpu?: boolean;
  os_class?: string;
}

export interface PolicyRequestConditions {
  /** est_prompt_tokens must be <= this. */
  max_est_prompt_tokens?: number;
  /** (max_tokens ?? default_max_tokens) must be <= this. */
  max_max_tokens?: number;
  /** request stream flag must equal this. */
  stream?: boolean;
}

export interface PolicyRule {
  rule_id: string;
  target: RouteTarget;
  /** B-1: may privacy force local on this hardware class? R4/R5 true. */
  privacy_local_eligible: boolean;
  hw: PolicyHwConditions;
  request: PolicyRequestConditions;
  rationale: string;
}

export interface PolicyTable {
  policy_version: string;
  default_max_tokens: number;
  rules: PolicyRule[];
}

export interface RequestFacts {
  est_prompt_tokens: number;
  /** Requested max_tokens; null → policy default applies. */
  max_tokens: number | null;
  stream: boolean;
  privacy: boolean;
}

export type PolicyDecision =
  | { kind: "route"; target: RouteTarget; rule_id: string }
  | { kind: "privacy-unroutable"; rule_id: string; reason: string };

function hwMatches(hw: PolicyHwConditions, probe: RouterProbe): boolean {
  if (hw.env !== undefined && hw.env !== probe.env) return false;
  if (hw.webgpu !== undefined && hw.webgpu !== probe.webgpu) return false;
  if (hw.os_class !== undefined && hw.os_class !== probe.os_class) return false;
  return true;
}

function requestMatches(
  req: PolicyRequestConditions,
  facts: RequestFacts,
  defaultMaxTokens: number,
): boolean {
  if (req.max_est_prompt_tokens !== undefined && facts.est_prompt_tokens > req.max_est_prompt_tokens) {
    return false;
  }
  if (req.max_max_tokens !== undefined && (facts.max_tokens ?? defaultMaxTokens) > req.max_max_tokens) {
    return false;
  }
  if (req.stream !== undefined && facts.stream !== req.stream) return false;
  return true;
}

/**
 * @param modelStruck strike score >= 1 for the configured local model
 *   (spec Section 6 short-circuit; B-2 for the privacy interaction).
 */
export function evaluatePolicy(
  policy: PolicyTable,
  probe: RouterProbe,
  facts: RequestFacts,
  modelStruck: boolean,
): PolicyDecision {
  if (facts.privacy) {
    for (const rule of policy.rules) {
      if (!hwMatches(rule.hw, probe)) continue;
      if (!rule.privacy_local_eligible) {
        return {
          kind: "privacy-unroutable",
          rule_id: rule.rule_id,
          reason: `no local path on this hardware class (${rule.rule_id}); privacy forbids server`,
        };
      }
      if (modelStruck) {
        // B-2: forcing local on a model with kill history would kill the tab.
        return {
          kind: "privacy-unroutable",
          rule_id: `${rule.rule_id}+strike`,
          reason: "local model is struck (kill history) and privacy forbids server",
        };
      }
      const forced = !requestMatches(rule.request, facts, policy.default_max_tokens);
      return {
        kind: "route",
        target: "local",
        rule_id: forced ? `${rule.rule_id}+privacy` : rule.rule_id,
      };
    }
    return { kind: "privacy-unroutable", rule_id: "none", reason: "no policy rule matched" };
  }

  for (const rule of policy.rules) {
    if (!hwMatches(rule.hw, probe)) continue;
    if (!requestMatches(rule.request, facts, policy.default_max_tokens)) continue;
    if (rule.target === "local" && modelStruck) {
      return { kind: "route", target: "server", rule_id: `${rule.rule_id}+strike` };
    }
    return { kind: "route", target: rule.target, rule_id: rule.rule_id };
  }
  // Unreachable with the bundled table (R6 is condition-free), but a custom
  // policy without a default still routes safe.
  return { kind: "route", target: "server", rule_id: "none" };
}
