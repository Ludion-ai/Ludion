import type { ChatCompletion, ChatCompletionChunk, ChatUsage, RouterProbe } from "@ludion/shared";
import { probeRouterDevice } from "@ludion/shared";
import {
  LudionMidStreamError,
  LudionNoFallbackConfigured,
  LudionPrivacyUnroutable,
  errorMessage,
  isContextOverflowError,
} from "./errors";
import type { LocalExecutor } from "./local";
import { createWebLLMExecutor } from "./local";
import type { PolicyTable, RequestFacts } from "./policy";
import { evaluatePolicy } from "./policy";
import type { ServerExecutor } from "./server";
import { createFetchServerExecutor, createNoFallbackExecutor } from "./server";
import { createSafeBrowserKV, DEFAULT_STRIKE_TTL_MS, STRIKE_CAUGHT, StrikeStore } from "./strikes";
import { estimatePromptTokens } from "./tokens";
import type { DecisionLog, FallbackConfig, LudionChatRequest, LudionOptions, GenRequest } from "./types";
import { DEFAULT_LOCAL_CONTEXT_WINDOW, DEFAULT_LOCAL_MODEL, POLICY_V0 } from "./defaults";
import { resolveEffectiveFallback } from "./config";
import { DECISION_SCHEMA_VERSION, emitDecision, newDecisionId } from "./telemetry";
import { enableLocalLedger } from "./savings";
import { enableCentralTelemetry } from "./telemetry-central";

// Public API surface (Gate 2 decisions Q3 — frozen at publish):
// the Ludion facade, the typed errors, and the types those signatures
// require. Internal machinery (strike store, SSE parser, executors, policy
// evaluator, defaults) is deliberately unexported; demand for it is an issue.
// 0.1.1 (Phase 0) added exactly one error: LudionNoFallbackConfigured.
export type {
  DecisionLog,
  LudionChatRequest,
  LudionOptions,
  FallbackConfig,
  ModelId,
} from "./types";
export type { PolicyTable, PolicyRule, RouteTarget } from "./policy";
export { LudionMidStreamError, LudionNoFallbackConfigured, LudionPrivacyUnroutable } from "./errors";

// Runtime config seam (Spec A injection + Spec B step 1 persistence). The
// facade reads the active source per request (see resolveFallback), so a UI
// that calls setConfigSource/writeDropinConfig is honored on the next request
// with no page reload. Lives in the leaf config.ts; re-exported here as the
// core entry's config surface.
export type { LudionDropinConfig, ConfigSource, ConfigStorage, StorageConfigSourceOptions } from "./config";
export {
  DROPIN_CONFIG_VERSION,
  DEFAULT_CONFIG_STORAGE_KEY,
  setDropinConfig,
  getDropinConfig,
  setConfigSource,
  validateDropinConfig,
  createStorageConfigSource,
  writeDropinConfig,
} from "./config";
export { LudionConfigError } from "./errors";

export type LudionStreamResponse = AsyncIterable<ChatCompletionChunk> & {
  readonly _ludion: DecisionLog;
};
export type LudionCompletionResponse = ChatCompletion & { readonly _ludion: DecisionLog };

function attachLog<T extends object>(obj: T, log: DecisionLog): T & { readonly _ludion: DecisionLog } {
  Object.defineProperty(obj, "_ludion", { value: log, enumerable: false });
  return obj as T & { readonly _ludion: DecisionLog };
}

export class Ludion {
  readonly probe: RouterProbe;
  readonly chat: { completions: { create: Ludion["createCompletion"] } };

  private readonly policy: PolicyTable;
  private readonly localModel: string;
  private readonly localContextWindow: number;
  private readonly strikes: StrikeStore;
  private readonly local: LocalExecutor;
  /** `create()`-time fallback (the per-request base; live config fills its gaps). */
  private readonly baseFallback: FallbackConfig | undefined;
  /** Test-injected server executor pins the server deterministically (ignores live config). */
  private readonly testServerExecutor: ServerExecutor | undefined;
  /** Reused no-fallback executor for the unconfigured (Phase 0) path. */
  private readonly noFallbackExecutor: ServerExecutor;
  /** Per-instance memo of fetch executors keyed by resolved {url, model, apiKey}. */
  private readonly serverCache = new Map<string, ServerExecutor>();
  private readonly onDecision: ((log: DecisionLog) => void) | undefined;
  private readonly privacyDefault: boolean;
  private readonly now: () => number;

  private constructor(options: LudionOptions, probe: RouterProbe, strikes: StrikeStore, now: () => number) {
    this.probe = probe;
    this.policy = options.policy ?? POLICY_V0;
    this.localModel = options.localModel ?? DEFAULT_LOCAL_MODEL;
    this.localContextWindow = options.localContextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
    this.strikes = strikes;
    this.local = options._test?.localExecutor ?? createWebLLMExecutor(options.onLocalLoadProgress);
    // Phase 0: fallback is optional. The effective fallback is resolved PER
    // REQUEST (resolveFallback) from create()-time config layered with the live
    // injected config, so a UI config change is honored without a page reload.
    this.baseFallback = options.fallback;
    this.testServerExecutor = options._test?.serverExecutor;
    this.noFallbackExecutor = createNoFallbackExecutor();
    this.onDecision = options.onDecision;
    this.privacyDefault = options.hints?.privacy ?? false;
    this.now = now;
    this.chat = { completions: { create: this.createCompletion.bind(this) } };
  }

  /** Resolved server target for one request: executor + whether a fallback exists + its model. */
  private resolveFallback(): { server: ServerExecutor; hasFallback: boolean; fallbackModel: string } {
    // An injected test executor pins the server (tests omit `fallback` and must
    // not depend on global config state); live config is ignored in that mode.
    if (this.testServerExecutor !== undefined) {
      return {
        server: this.testServerExecutor,
        hasFallback: true,
        fallbackModel: this.baseFallback?.model ?? "unconfigured",
      };
    }
    // Precedence (Spec B): create()-time fields win, live injected config fills
    // the rest. No injected config → identical to capturing options.fallback.
    const fallback = resolveEffectiveFallback(this.baseFallback);
    if (fallback === undefined) {
      return { server: this.noFallbackExecutor, hasFallback: false, fallbackModel: "unconfigured" };
    }
    return { server: this.serverExecutorFor(fallback), hasFallback: true, fallbackModel: fallback.model };
  }

  private serverExecutorFor(fallback: FallbackConfig): ServerExecutor {
    const key = JSON.stringify([fallback.url, fallback.model, fallback.apiKey ?? ""]);
    let ex = this.serverCache.get(key);
    if (ex === undefined) {
      ex = createFetchServerExecutor(fallback);
      this.serverCache.set(key, ex);
    }
    return ex;
  }

  static async create(options: LudionOptions = {}): Promise<Ludion> {
    const kv = options._test?.kv ?? createSafeBrowserKV();
    const now = options._test?.now ?? Date.now;
    const strikes = new StrikeStore(kv, options.strikeTtlMs ?? DEFAULT_STRIKE_TTL_MS, now);
    // Spec Section 6: a tombstone surviving into this boot means the previous
    // local load/generate killed the tab → +1.0 strike for that model.
    strikes.recoverTombstone();
    // Probe once per Ludion instance (per page load). Never imports WebLLM.
    const probe = options._test?.probe ?? (await probeRouterDevice());
    // Local ledger is default-on (local-only): subscribe it to the decision
    // sink once so every decision — drop-in path included — is recorded without
    // manual onDecision wiring. Idempotent across instances (no double-count).
    enableLocalLedger();
    // Central telemetry is opt-in/default-off: the consumer drops every event
    // (no buffer, no network) until the drop-in config sets telemetry.central +
    // endpoint + projectId. Safe to register unconditionally.
    enableCentralTelemetry();
    return new Ludion(options, probe, strikes, now);
  }

  private createCompletion(
    req: LudionChatRequest & { stream: true },
  ): Promise<LudionStreamResponse>;
  private createCompletion(
    req: LudionChatRequest & { stream?: false },
  ): Promise<LudionCompletionResponse>;
  private createCompletion(
    req: LudionChatRequest,
  ): Promise<LudionStreamResponse | LudionCompletionResponse>;
  private async createCompletion(
    req: LudionChatRequest,
  ): Promise<LudionStreamResponse | LudionCompletionResponse> {
    const privacy = req.ludion?.privacy ?? this.privacyDefault;
    const facts: RequestFacts = {
      est_prompt_tokens: estimatePromptTokens(req.messages),
      max_tokens: req.max_tokens ?? null,
      stream: req.stream === true,
      privacy,
    };
    const struck = this.strikes.isStruck(this.localModel);
    const decision = evaluatePolicy(this.policy, this.probe, facts, struck);
    // Read-point (Spec B): resolve the effective fallback for THIS request.
    const fb = this.resolveFallback();

    const log: DecisionLog = {
      schema_version: DECISION_SCHEMA_VERSION,
      decision_id: newDecisionId(),
      policy_version: this.policy.policy_version,
      rule_id: decision.rule_id,
      target: decision.kind === "route" ? decision.target : "unroutable",
      model:
        decision.kind === "route" && decision.target === "local"
          ? this.localModel
          : fb.fallbackModel,
      privacy,
      stream: facts.stream,
      est_prompt_tokens: facts.est_prompt_tokens,
      max_tokens: facts.max_tokens ?? this.policy.default_max_tokens,
      local_context_window: this.localContextWindow,
      cache_state: "unknown",
      load_total_ms: null,
      strike_state: this.strikes.snapshot(),
      probe: this.probe,
      decided_at: new Date(this.now()).toISOString(),
      completed: false,
      degraded: null,
      degraded_failed: false,
      cancelled: false,
      ttft_ms: null,
      tps: null,
      tokens_in: null,
      tokens_out: null,
      tokens_source: "estimated",
      error: null,
    };
    const emitOnce = (() => {
      let emitted = false;
      return () => {
        if (emitted) return;
        emitted = true;
        try {
          this.onDecision?.(log);
        } catch {
          // consumer callback errors must not break the request
        }
        // Module-level sink (local ledger + opt-in central). Inference-path
        // safe: a single synchronous buffer push, drained on a microtask.
        emitDecision(log);
      };
    })();

    if (decision.kind === "privacy-unroutable") {
      const err = new LudionPrivacyUnroutable(decision.rule_id, decision.reason);
      log.error = errorMessage(err);
      emitOnce();
      throw err;
    }

    // Phase 0 local-only mode: a server route with no fallback endpoint is a
    // typed, decision-time error — never a fetch to nowhere.
    if (decision.target === "server" && !fb.hasFallback) {
      const err = new LudionNoFallbackConfigured(decision.rule_id);
      log.error = errorMessage(err);
      emitOnce();
      throw err;
    }

    const genReq: GenRequest = {
      messages: req.messages,
      max_tokens: log.max_tokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    if (!facts.stream) {
      return this.runNonStream(genReq, decision.target, privacy, log, emitOnce, fb);
    }
    return this.buildStreamResponse(genReq, decision.target, privacy, log, emitOnce, fb);
  }

  // --- shared local plumbing ----------------------------------------------

  /** +0.5 strike for a caught local failure — unless B-3 (context overflow). */
  private recordCaughtLocalFailure(e: unknown): void {
    if (!isContextOverflowError(e)) this.strikes.addStrike(this.localModel, STRIKE_CAUGHT);
  }

  /**
   * Load under a "load"-stage tombstone (tab kill during download/init → kill
   * strike on next boot). Records the on-device cache state and, for a cold
   * load, the total load wall time onto the decision log.
   */
  private async ensureLocalLoaded(log: DecisionLog): Promise<void> {
    this.strikes.writeTombstone(this.localModel, "load");
    const startedAt = this.now();
    try {
      const { cacheState } = await this.local.ensureLoaded(this.localModel, this.localContextWindow);
      log.cache_state = cacheState;
      log.load_total_ms = cacheState === "cold" ? this.now() - startedAt : null;
    } finally {
      // Reached on resolve OR caught throw; a tab kill never reaches it.
      this.strikes.clearTombstone();
    }
  }

  // --- non-streaming path (A-2: always transparently retryable) ------------

  private async runNonStream(
    genReq: GenRequest,
    target: "local" | "server",
    privacy: boolean,
    log: DecisionLog,
    emitOnce: () => void,
    fb: { server: ServerExecutor; hasFallback: boolean; fallbackModel: string },
  ): Promise<LudionCompletionResponse> {
    if (target === "local") {
      try {
        await this.ensureLocalLoaded(log);
        this.strikes.writeTombstone(this.localModel, "generate");
        try {
          const completion = await this.local.complete(genReq);
          this.strikes.clearTombstone();
          this.finalizeUsage(log, completion.usage ?? null, null);
          log.completed = true;
          emitOnce();
          return attachLog(completion, log);
        } catch (e) {
          this.strikes.clearTombstone(); // caught, not a kill
          throw e;
        }
      } catch (e) {
        this.recordCaughtLocalFailure(e);
        log.strike_state = this.strikes.snapshot();
        if (privacy) {
          log.error = errorMessage(e);
          emitOnce();
          throw e;
        }
        if (!fb.hasFallback) {
          // Phase 0: no server to degrade to — typed error instead of A-2 retry.
          const err = new LudionNoFallbackConfigured(log.rule_id);
          log.error = errorMessage(err);
          emitOnce();
          throw err;
        }
        log.degraded = "local→server";
        log.model = fb.fallbackModel;
      }
    }
    try {
      const completion = await fb.server.complete(genReq, new AbortController().signal);
      this.finalizeUsage(log, completion.usage ?? null, null);
      log.completed = true;
      emitOnce();
      return attachLog(completion, log);
    } catch (e) {
      log.error = errorMessage(e);
      emitOnce();
      throw e;
    }
  }

  private finalizeUsage(
    log: DecisionLog,
    usage: ChatUsage | null,
    contentChunks: number | null,
  ): void {
    log.tokens_in = usage?.prompt_tokens ?? null;
    log.tokens_out = usage?.completion_tokens ?? contentChunks;
    log.tokens_source = usage != null ? "exact" : "estimated";
  }

  // --- streaming path (Q3 / A-2 two-branch degrade) -------------------------

  private buildStreamResponse(
    genReq: GenRequest,
    initialTarget: "local" | "server",
    privacy: boolean,
    log: DecisionLog,
    emitOnce: () => void,
    fb: { server: ServerExecutor; hasFallback: boolean; fallbackModel: string },
  ): LudionStreamResponse {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    async function* run(): AsyncGenerator<ChatCompletionChunk, void, void> {
      let target = initialTarget;
      // ref-object: assignments happen inside closures, which TS control-flow
      // analysis does not track on plain let bindings
      const abortRef: { c: AbortController | null } = { c: null };
      let localInFlight = false;
      let firstTokenAt: number | null = null;
      let lastTokenAt: number | null = null;
      let contentChunks = 0;
      let usage: ChatUsage | null = null;
      let genStart = self.now();
      let terminal = false; // reached completion or a handled error (vs consumer break)

      const consume = async function* (
        it: AsyncIterable<ChatCompletionChunk>,
      ): AsyncGenerator<ChatCompletionChunk, void, void> {
        for await (const chunk of it) {
          if (chunk.choices[0]?.delta?.content) {
            const t = self.now();
            if (firstTokenAt === null) firstTokenAt = t;
            lastTokenAt = t;
            contentChunks++;
          }
          if (chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      };

      const openServer = (): AsyncIterable<ChatCompletionChunk> => {
        abortRef.c = new AbortController();
        return fb.server.stream(genReq, abortRef.c.signal);
      };

      try {
        try {
          if (target === "local") {
            let localSource: AsyncIterable<ChatCompletionChunk> | null = null;
            try {
              await self.ensureLocalLoaded(log);
              genStart = self.now(); // D-3: ttft measured from generation start, excluding model load
              self.strikes.writeTombstone(self.localModel, "generate");
              localInFlight = true;
              localSource = await self.local.stream(genReq);
            } catch (e) {
              // Failure before generation produced anything (load or stream setup).
              if (localInFlight) {
                self.strikes.clearTombstone();
                localInFlight = false;
              }
              self.recordCaughtLocalFailure(e);
              log.strike_state = self.strikes.snapshot();
              if (privacy) throw e;
              localSource = null;
            }
            if (localSource) {
              try {
                yield* consume(localSource);
                self.strikes.clearTombstone();
                localInFlight = false;
              } catch (e) {
                self.strikes.clearTombstone(); // caught error, not a kill
                localInFlight = false;
                self.recordCaughtLocalFailure(e);
                log.strike_state = self.strikes.snapshot();
                if (privacy) throw e;
                if (firstTokenAt !== null) {
                  // A-2: yielded tokens cannot be recalled — no transparent
                  // retry after the first content token. Typed stream error.
                  log.degraded_failed = true;
                  throw new LudionMidStreamError(
                    "local generation failed after first token; transparent retry impossible",
                    { cause: e },
                  );
                }
                localSource = null;
              }
            }
            if (localSource === null) {
              // Phase 0: no server to degrade to — typed error (outer catch
              // records it in the log and emits).
              if (!fb.hasFallback) throw new LudionNoFallbackConfigured(log.rule_id);
              // A-2: transparent retry — nothing was yielded yet.
              log.degraded = "local→server";
              log.model = fb.fallbackModel;
              target = "server";
              genStart = self.now();
              yield* consume(openServer());
            }
          } else {
            yield* consume(openServer());
          }
        } catch (e) {
          terminal = true;
          log.error = errorMessage(e);
          emitOnce();
          throw e;
        }
        // Completed normally.
        terminal = true;
        if (firstTokenAt !== null) log.ttft_ms = firstTokenAt - genStart;
        if (firstTokenAt !== null && lastTokenAt !== null && contentChunks > 1) {
          const intervalMs = lastTokenAt - firstTokenAt;
          if (intervalMs > 0) log.tps = (contentChunks - 1) / (intervalMs / 1000);
        }
        self.finalizeUsage(log, usage, contentChunks > 0 ? contentChunks : null);
        log.completed = true;
        emitOnce();
      } finally {
        if (!terminal) {
          // Consumer stopped iterating (break / return): cancel the producer.
          // local → interruptGenerate() ([VERIFY-2]); server → abort().
          log.cancelled = true;
          if (localInFlight) {
            self.strikes.clearTombstone();
            localInFlight = false;
            try {
              await self.local.interrupt();
            } catch {
              // interruption best-effort
            }
          }
          abortRef.c?.abort();
          emitOnce();
        } else if (target === "server") {
          // Stream fully drained; release the connection.
          abortRef.c?.abort();
        }
      }
    }

    const gen = run();
    return attachLog<AsyncIterable<ChatCompletionChunk>>(
      {
        [Symbol.asyncIterator]() {
          return gen;
        },
      },
      log,
    );
  }
}
