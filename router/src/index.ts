import type { ChatCompletion, ChatCompletionChunk, ChatUsage, RouterProbe } from "@ludion/shared";
import { probeRouterDevice } from "@ludion/shared";
import { LudionMidStreamError, LudionPrivacyUnroutable, errorMessage, isContextOverflowError } from "./errors";
import type { LocalExecutor } from "./local";
import { createWebLLMExecutor } from "./local";
import type { PolicyTable, RequestFacts } from "./policy";
import { evaluatePolicy } from "./policy";
import type { ServerExecutor } from "./server";
import { createFetchServerExecutor } from "./server";
import { createSafeBrowserKV, DEFAULT_STRIKE_TTL_MS, STRIKE_CAUGHT, StrikeStore } from "./strikes";
import { estimatePromptTokens } from "./tokens";
import type { DecisionLog, LudionChatRequest, LudionOptions, GenRequest } from "./types";
import { DEFAULT_LOCAL_CONTEXT_WINDOW, DEFAULT_LOCAL_MODEL, POLICY_V0 } from "./defaults";

// Public API surface (Gate 2 decisions Q3 — frozen at publish):
// the Ludion facade, the two typed errors, and the types those signatures
// require. Internal machinery (strike store, SSE parser, executors, policy
// evaluator, defaults) is deliberately unexported; demand for it is an issue.
export type {
  DecisionLog,
  LudionChatRequest,
  LudionOptions,
  FallbackConfig,
  ModelId,
} from "./types";
export type { PolicyTable, PolicyRule, RouteTarget } from "./policy";
export { LudionMidStreamError, LudionPrivacyUnroutable } from "./errors";

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
  private readonly server: ServerExecutor;
  private readonly onDecision: ((log: DecisionLog) => void) | undefined;
  private readonly privacyDefault: boolean;
  private readonly fallbackModel: string;
  private readonly now: () => number;

  private constructor(options: LudionOptions, probe: RouterProbe, strikes: StrikeStore, now: () => number) {
    this.probe = probe;
    this.policy = options.policy ?? POLICY_V0;
    this.localModel = options.localModel ?? DEFAULT_LOCAL_MODEL;
    this.localContextWindow = options.localContextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
    this.strikes = strikes;
    this.local = options._test?.localExecutor ?? createWebLLMExecutor(options.onLocalLoadProgress);
    this.server = options._test?.serverExecutor ?? createFetchServerExecutor(options.fallback);
    this.onDecision = options.onDecision;
    this.privacyDefault = options.hints?.privacy ?? false;
    this.fallbackModel = options.fallback.model;
    this.now = now;
    this.chat = { completions: { create: this.createCompletion.bind(this) } };
  }

  static async create(options: LudionOptions): Promise<Ludion> {
    const kv = options._test?.kv ?? createSafeBrowserKV();
    const now = options._test?.now ?? Date.now;
    const strikes = new StrikeStore(kv, options.strikeTtlMs ?? DEFAULT_STRIKE_TTL_MS, now);
    // Spec Section 6: a tombstone surviving into this boot means the previous
    // local load/generate killed the tab → +1.0 strike for that model.
    strikes.recoverTombstone();
    // Probe once per Ludion instance (per page load). Never imports WebLLM.
    const probe = options._test?.probe ?? (await probeRouterDevice());
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

    const log: DecisionLog = {
      policy_version: this.policy.policy_version,
      rule_id: decision.rule_id,
      target: decision.kind === "route" ? decision.target : "unroutable",
      model:
        decision.kind === "route" && decision.target === "local"
          ? this.localModel
          : this.fallbackModel,
      privacy,
      stream: facts.stream,
      est_prompt_tokens: facts.est_prompt_tokens,
      max_tokens: facts.max_tokens ?? this.policy.default_max_tokens,
      local_context_window: this.localContextWindow,
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
      };
    })();

    if (decision.kind === "privacy-unroutable") {
      const err = new LudionPrivacyUnroutable(decision.rule_id, decision.reason);
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
      return this.runNonStream(genReq, decision.target, privacy, log, emitOnce);
    }
    return this.buildStreamResponse(genReq, decision.target, privacy, log, emitOnce);
  }

  // --- shared local plumbing ----------------------------------------------

  /** +0.5 strike for a caught local failure — unless B-3 (context overflow). */
  private recordCaughtLocalFailure(e: unknown): void {
    if (!isContextOverflowError(e)) this.strikes.addStrike(this.localModel, STRIKE_CAUGHT);
  }

  /** Load under a "load"-stage tombstone (tab kill during download/init → kill strike on next boot). */
  private async ensureLocalLoaded(): Promise<void> {
    this.strikes.writeTombstone(this.localModel, "load");
    try {
      await this.local.ensureLoaded(this.localModel, this.localContextWindow);
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
  ): Promise<LudionCompletionResponse> {
    if (target === "local") {
      try {
        await this.ensureLocalLoaded();
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
        log.degraded = "local→server";
        log.model = this.fallbackModel;
      }
    }
    try {
      const completion = await this.server.complete(genReq, new AbortController().signal);
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
  }

  // --- streaming path (Q3 / A-2 two-branch degrade) -------------------------

  private buildStreamResponse(
    genReq: GenRequest,
    initialTarget: "local" | "server",
    privacy: boolean,
    log: DecisionLog,
    emitOnce: () => void,
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
        return self.server.stream(genReq, abortRef.c.signal);
      };

      try {
        try {
          if (target === "local") {
            let localSource: AsyncIterable<ChatCompletionChunk> | null = null;
            try {
              await self.ensureLocalLoaded();
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
              // A-2: transparent retry — nothing was yielded yet.
              log.degraded = "local→server";
              log.model = self.fallbackModel;
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
