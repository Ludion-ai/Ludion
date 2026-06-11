/**
 * Internal defaults (not public API — Gate 2 decisions Q3: the public surface
 * is Ludion + error classes + types only; everything else is unexported).
 */
import type { PolicyTable } from "./policy";
import policyV0 from "./policy.v0.json";

export const DEFAULT_LOCAL_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
/** B-4: router-side KV window default (decision-logged per request). */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 4096;
/** The bundled v0 policy table. */
export const POLICY_V0 = policyV0 as PolicyTable;
