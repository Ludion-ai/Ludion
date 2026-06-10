/**
 * Minimal OpenAI-compatible chat types — the single normalized shape both
 * router targets emit (Gate 1 decisions Q3). Deliberately independent of
 * `@mlc-ai/web-llm` types so the server path never imports engine code.
 * WebLLM 0.2.84 chunks are structurally assignable to these shapes
 * ([VERIFY-1]: `engine.chat.completions.create({stream:true})` natively
 * returns an AsyncIterable of OpenAI-style chunks).
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

export interface ChunkChoice {
  index: number;
  delta: { role?: string; content?: string | null };
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: ChatUsage | null;
}

export interface CompletionChoice {
  index: number;
  message: { role: string; content: string | null };
  finish_reason: string | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: ChatUsage | null;
}
