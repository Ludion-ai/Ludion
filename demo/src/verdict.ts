/**
 * Probe-card verdict (Gate 2.5 decisions F-1).
 *
 * INTENTIONAL DUPLICATION: the router's policy evaluator is deliberately
 * unexported (Gate 2 Q3 froze the public API), so this demo evaluates the
 * policy *presentationally*: rule data comes straight from the router's
 * policy.v0.json (single source of truth — workspace-relative import); only
 * the ~30 lines of matching logic are duplicated here. The card says
 * "eligible"; the authoritative per-request rule always comes from
 * `stream._ludion`. Strike state is intentionally ignored (F-1 residual).
 */
import policy from "../../router/src/policy.v0.json";

export interface ProbeFacts {
  webgpu: boolean;
  env: string;
  os_class: string;
}

export interface Verdict {
  rule_id: string;
  target: "local" | "server";
  /** Request-shape caveat, e.g. R5's short-prompt-only eligibility. */
  shortPromptsOnly: boolean;
}

interface RuleJson {
  rule_id: string;
  target: string;
  hw: { env?: string; webgpu?: boolean; os_class?: string };
  request: { max_est_prompt_tokens?: number; max_max_tokens?: number; stream?: boolean };
}

/**
 * Representative request facts: a short streamed prompt at the default
 * max_tokens — "what happens if you just type something here".
 */
const REPRESENTATIVE = { est_prompt_tokens: 16, max_tokens: 256, stream: true };

export function evaluateVerdict(probe: ProbeFacts): Verdict {
  for (const rule of policy.rules as RuleJson[]) {
    const hw = rule.hw;
    if (hw.env !== undefined && hw.env !== probe.env) continue;
    if (hw.webgpu !== undefined && hw.webgpu !== probe.webgpu) continue;
    if (hw.os_class !== undefined && hw.os_class !== probe.os_class) continue;
    const req = rule.request;
    if (req.max_est_prompt_tokens !== undefined && REPRESENTATIVE.est_prompt_tokens > req.max_est_prompt_tokens) continue;
    if (req.max_max_tokens !== undefined && REPRESENTATIVE.max_tokens > req.max_max_tokens) continue;
    if (req.stream !== undefined && req.stream !== REPRESENTATIVE.stream) continue;
    return {
      rule_id: rule.rule_id,
      target: rule.target as "local" | "server",
      shortPromptsOnly: req.max_est_prompt_tokens !== undefined && req.max_est_prompt_tokens < 1000,
    };
  }
  // policy.v0 ends in a catch-all; unreachable, but never throw in the demo.
  return { rule_id: "R6", target: "server", shortPromptsOnly: false };
}
