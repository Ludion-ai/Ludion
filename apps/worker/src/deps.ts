import type { FetchFn } from "./github.ts";

/** Outbound I/O and time, injectable so tests can mock GitHub and source pages. */
export interface Deps {
  fetch: FetchFn;
  now: () => number;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};
