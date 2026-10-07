import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchFn, Lesson } from "../src/index.ts";

export const EXAMPLE_PATH = fileURLToPath(new URL("../../../lessons/python/01K6ZQ4T9X0N8V2H7M3P5R1S6W.json", import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL("../../../lessons/lessons.schema.json", import.meta.url));

export const exampleText = (): string => readFileSync(EXAMPLE_PATH, "utf8");
export const example = (): Lesson => JSON.parse(exampleText()) as Lesson;

let n = 0;
/** A valid lesson with a fresh, increasing id. */
export function lesson(overrides: Partial<Lesson> = {}): Lesson {
  n++;
  return {
    id: `01K6ZQ4T9X0N8V2H7M3P5R${String(n).padStart(4, "0")}`,
    subject: "python",
    claim: `Lesson number ${n} says something true.`,
    evidence: [{ source: { url: "https://example.com/", quote: "something true" } }],
    author: "github:alice",
    author_id: 1001,
    created_at: "2026-10-07T00:00:00Z",
    ...overrides,
  };
}

/** A fetch that serves fixed responses by URL and records calls. */
export function fakeFetch(routes: Record<string, () => Response>): FetchFn & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new TypeError(`fetch failed: ${url}`);
    return route();
  };
  return Object.assign(fn, { calls });
}
