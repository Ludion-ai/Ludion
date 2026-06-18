/**
 * OpenAI drop-in entry (Spec A) — adapter #1 on the drop-in seam.
 *
 * Goal: existing OpenAI code runs through the Ludion router by changing ONE
 * import line and nothing else.
 *
 *   // before
 *   import OpenAI from "openai";
 *   // after
 *   import OpenAI from "https://esm.run/ludion-router/openai";
 *
 *   const client = new OpenAI({ apiKey });
 *   const res = await client.chat.completions.create({ model: "gpt-4o", messages });
 *   // res is OpenAI-shaped; res._ludion carries the routing DecisionLog.
 *
 * Under the hood: Ludion judges (PolicyTable) → runs on-device via WebLLM where
 * eligible → degrades to the caller's `model` at `baseURL` otherwise. The
 * caller's `model` string is the FALLBACK target (the router has no per-request
 * on-device model input); on-device uses the router's configured local model.
 *
 * The router already emits the OpenAI response shape with a non-enumerable
 * `_ludion`, so this adapter's response hooks are identity passthrough. A
 * future Anthropic/VercelAI adapter is a sibling file implementing `SdkAdapter`
 * with real response reshaping — the router core never changes.
 */
import type { ChatMessage } from "@ludion/shared";
import type {
  LudionChatRequest,
  LudionCompletionResponse,
  LudionStreamResponse,
} from "./index";
import type { SdkAdapter } from "./dropin";
import { resolveLudion, resolveRouting } from "./dropin";
import { LudionUnsupportedParamError } from "./errors";
import type { LudionOptions } from "./types";

export type {
  LudionDropinConfig,
  ConfigSource,
  SdkAdapter,
} from "./dropin";
export {
  setDropinConfig,
  getDropinConfig,
  setConfigSource,
  validateDropinConfig,
  DROPIN_CONFIG_VERSION,
} from "./dropin";
export { LudionConfigError, LudionUnsupportedParamError } from "./errors";
export type { DecisionLog, FallbackConfig } from "./types";
export type { LudionCompletionResponse, LudionStreamResponse } from "./index";

/**
 * Supported-surface policy (Spec A.1). The drop-in honors only these params;
 * anything else is handled LOUDLY, never silently dropped.
 *   - correctness-affecting params → hard throw (before any inference),
 *   - best-effort/cosmetic + unknown params → warn once (by name), then run.
 * See README "OpenAI drop-in" for the contract.
 */
const SUPPORTED_PARAMS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "ludion",
]);

/** Change what the model is asked to do or return; ignoring them is dangerous. */
const HARD_UNSUPPORTED_PARAMS: ReadonlySet<string> = new Set([
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "n",
  "logprobs",
  "top_logprobs",
  "logit_bias",
]);

// console.warn at most once per distinct param name per process.
const warnedParams = new Set<string>();

/**
 * Enforce the supported surface. Throws `LudionUnsupportedParamError` naming
 * every correctness-affecting param present; warns once for cosmetic/unknown
 * params and lets the request proceed. Must be called before routing so a
 * dangerous request never loads a model or fetches a fallback.
 */
function enforceSupportedParams(req: object): void {
  const unknown = Object.keys(req).filter((k) => !SUPPORTED_PARAMS.has(k));
  const dangerous = unknown.filter((k) => HARD_UNSUPPORTED_PARAMS.has(k));
  if (dangerous.length > 0) throw new LudionUnsupportedParamError(dangerous);
  for (const k of unknown) {
    if (warnedParams.has(k)) continue;
    warnedParams.add(k);
    console.warn(
      `ludion drop-in ignores '${k}': not yet honored, so output may differ in quality ` +
        `(response shape is unaffected). supported params: messages, model, stream, temperature, max_tokens.`,
    );
  }
}

/** Test-only: clear the warn-once memory so a warn assertion is repeatable. */
export function _resetParamWarnings(): void {
  warnedParams.clear();
}

/** Minimal OpenAI `chat.completions.create` params we honor (impersonation). */
export interface ChatCompletionCreateParams {
  /** Treated as the developer's fallback target (not forced to "auto"). */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  /** OpenAI's current field. */
  max_completion_tokens?: number;
  /** OpenAI's deprecated field; accepted for compatibility. */
  max_tokens?: number;
  /** Ludion extension: per-request privacy hint (ignored by real OpenAI code). */
  ludion?: { privacy?: boolean };
}

/** OpenAI client constructor options we honor. */
export interface ClientOptions {
  apiKey?: string;
  /** Default "https://api.openai.com/v1"; "/chat/completions" is appended. */
  baseURL?: string;
  /** Accepted for source-compatibility with the real SDK; not required here. */
  dangerouslyAllowBrowser?: boolean;
  /** INTERNAL test hook (probe/executor injection). Not part of the OpenAI API. */
  __ludionTest?: LudionOptions["_test"];
}

/**
 * Adapter #1: OpenAI. Request translation only — the router already speaks the
 * OpenAI response shape, so the response hooks are identity (and `_ludion`
 * rides through untouched).
 */
export class OpenAIAdapter
  implements SdkAdapter<ChatCompletionCreateParams, LudionCompletionResponse, LudionStreamResponse>
{
  toLudionRequest(req: ChatCompletionCreateParams): {
    ludion: LudionChatRequest;
    model: string | undefined;
  } {
    const maxTokens = req.max_completion_tokens ?? req.max_tokens;
    const ludion: LudionChatRequest = {
      messages: req.messages,
      ...(req.stream !== undefined ? { stream: req.stream } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(req.ludion ? { ludion: req.ludion } : {}),
    };
    return { ludion, model: req.model };
  }
  fromCompletion(res: LudionCompletionResponse): LudionCompletionResponse {
    return res; // router already emits OpenAI shape; _ludion preserved
  }
  fromStream(res: LudionStreamResponse): LudionStreamResponse {
    return res; // router already emits OpenAI shape; _ludion preserved
  }
}

const adapter = new OpenAIAdapter();

/**
 * Drop-in stand-in for the `openai` SDK's default export. Construct it exactly
 * like the real client; call `client.chat.completions.create(...)`. Only the
 * `chat.completions.create` surface is implemented (see README divergences).
 */
export class OpenAI {
  readonly chat: {
    completions: {
      create: {
        (req: ChatCompletionCreateParams & { stream: true }): Promise<LudionStreamResponse>;
        (req: ChatCompletionCreateParams & { stream?: false }): Promise<LudionCompletionResponse>;
        (req: ChatCompletionCreateParams): Promise<LudionCompletionResponse | LudionStreamResponse>;
      };
    };
  };

  constructor(options: ClientOptions = {}) {
    const client = { apiKey: options.apiKey, baseURL: options.baseURL };
    const test = options.__ludionTest;

    const create = async (
      req: ChatCompletionCreateParams,
    ): Promise<LudionCompletionResponse | LudionStreamResponse> => {
      // Honesty gate (Spec A.1): fail loudly on unsupported input before any
      // model load or fallback fetch — never silently drop it.
      enforceSupportedParams(req);
      const { ludion: ludionReq, model } = adapter.toLudionRequest(req);
      const routing = resolveRouting(client, model);
      const ludion = await resolveLudion(routing, test);
      if (ludionReq.stream === true) {
        const res = await ludion.chat.completions.create({ ...ludionReq, stream: true });
        return adapter.fromStream(res);
      }
      const res = await ludion.chat.completions.create({ ...ludionReq, stream: false });
      return adapter.fromCompletion(res);
    };

    this.chat = { completions: { create: create as OpenAI["chat"]["completions"]["create"] } };
  }
}

export default OpenAI;
