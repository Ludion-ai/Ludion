// The portable suite (NEUT-1) on Node's own test runner, so `npm test` runs it in seconds.
// The same suite.mjs runs unmodified on Deno and workerd in accept/neutral/runtimes.mjs.
import { test } from "node:test";
import { registeredTests } from "./portable/shim.mjs";
import "./portable/suite.mjs";

for (const t of registeredTests()) test(`portable: ${t.name}`, t.fn);
