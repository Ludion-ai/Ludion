import type { ChatCompletion, ChatCompletionChunk } from "@ludion/shared";
import type { FallbackConfig, GenRequest } from "./types";

/**
 * Server fallback executor: direct browser fetch to the customer-supplied
 * OpenAI-compatible /chat/completions endpoint (no proxy). SSE is parsed
 * incrementally from the ReadableStream — no full-response buffering (Q3).
 * Cancellation: AbortController, aborted by the facade when the consumer
 * stops the stream.
 *
 * CORS (A-5): the endpoint must allow browser cross-origin requests from the
 * app origin; see FallbackConfig.url.
 */
export interface ServerExecutor {
  stream(req: GenRequest, signal: AbortSignal): AsyncGenerator<ChatCompletionChunk, void, void>;
  complete(req: GenRequest, signal: AbortSignal): Promise<ChatCompletion>;
}

/**
 * Incremental SSE parser: yields the joined `data:` payload of each event.
 * Handles CRLF, multi-line data fields, and ignores comments/other fields.
 */
export async function* sseDataEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (dataLines.length > 0) {
            yield dataLines.join("\n");
            dataLines = [];
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // other SSE fields (event:, id:, retry:) and ":" comments are ignored
      }
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released by stream cancellation
    }
  }
}

async function httpError(res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // body unavailable
  }
  return new Error(`ludion-router: fallback endpoint HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
}

export function createFetchServerExecutor(cfg: FallbackConfig): ServerExecutor {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  });

  return {
    async *stream(req: GenRequest, signal: AbortSignal): AsyncGenerator<ChatCompletionChunk, void, void> {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: req.messages,
          max_tokens: req.max_tokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stream: true,
          // Standard OpenAI option; servers that don't support usage chunks
          // simply omit them and the router falls back to chunk counting.
          stream_options: { include_usage: true },
        }),
      });
      if (!res.ok) throw await httpError(res);
      if (!res.body) throw new Error("ludion-router: fallback endpoint returned no body for stream");
      for await (const data of sseDataEvents(res.body)) {
        if (data === "[DONE]") return;
        yield JSON.parse(data) as ChatCompletionChunk;
      }
    },

    async complete(req: GenRequest, signal: AbortSignal): Promise<ChatCompletion> {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: headers(),
        signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: req.messages,
          max_tokens: req.max_tokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stream: false,
        }),
      });
      if (!res.ok) throw await httpError(res);
      return (await res.json()) as ChatCompletion;
    },
  };
}
