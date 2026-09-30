// Host for command-line runtimes (Node, Deno, Bun): run the portable suite and the conformance
// vectors, print one JSON line.
import { run, test } from "./shim.mjs";
import "./suite.mjs";
import { registerConformance } from "./conformance.mjs";
import vectors from "./vectors.json" with { type: "json" };

registerConformance(vectors, { test });
const runtime = globalThis.Deno ? "deno" : globalThis.Bun ? "bun" : "node";
const version = globalThis.Deno?.version?.deno ?? globalThis.Bun?.version ?? globalThis.process?.versions?.node;
console.log(JSON.stringify({ ...(await run({ runtime })), version }));
