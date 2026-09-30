// Host for command-line runtimes (Node, Deno, Bun): run the portable suite, print one JSON line.
import { run } from "./shim.mjs";
import "./suite.mjs";

const runtime = globalThis.Deno ? "deno" : globalThis.Bun ? "bun" : "node";
const version = globalThis.Deno?.version?.deno ?? globalThis.Bun?.version ?? globalThis.process?.versions?.node;
console.log(JSON.stringify({ ...(await run({ runtime })), version }));
