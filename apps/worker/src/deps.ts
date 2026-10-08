import { APP_BOT_ID } from "./config.ts";
import type { FetchFn } from "./github.ts";

/** Outbound I/O, time, and the App's bot id, injectable so tests can mock GitHub and source pages. */
export interface Deps {
  fetch: FetchFn;
  now: () => number;
  /** The Ludion App's bot account id (ludion.config.json); undefined keeps teaching closed. */
  appBotId: number | undefined;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  appBotId: APP_BOT_ID,
};