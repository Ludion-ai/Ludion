// Worker tests serve the real built site through ASSETS. Fail early, in plain words, if it is missing.
import { existsSync } from "node:fs";

export default function setup(): void {
  if (!existsSync("apps/site/dist/index.json")) {
    throw new Error("apps/site/dist is missing. The Worker tests serve the built site; run `npm run build` first, then `npm test`.");
  }
}
