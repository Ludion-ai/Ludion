// Preload (`node --import`) that makes any network or subprocess attempt fail loudly and
// leaves a record of it in $LUDION_NET_TRAP. Used by SCAN-3: the scan must make zero calls.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const LOG = process.env.LUDION_NET_TRAP;
if (!LOG) throw new Error("LUDION_NET_TRAP not set");
fs.appendFileSync(LOG, "armed\n");

function trap(name) {
  return function trapped() {
    fs.appendFileSync(LOG, `attempt ${name}\n`);
    throw new Error(`network disabled by SCAN-3 trap: ${name}`);
  };
}

const TARGETS = {
  net: ["connect", "createConnection", "createServer"],
  tls: ["connect", "createServer"],
  http: ["request", "get", "createServer"],
  https: ["request", "get", "createServer"],
  http2: ["connect", "createServer", "createSecureServer"],
  dgram: ["createSocket"],
  dns: ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "reverse"],
  child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
};
for (const [mod, fns] of Object.entries(TARGETS)) {
  const m = require(mod);
  for (const f of fns) if (typeof m[f] === "function") m[f] = trap(`${mod}.${f}`);
}
const dns = require("dns");
for (const f of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) if (dns.promises?.[f]) dns.promises[f] = trap(`dns.promises.${f}`);
const net = require("net");
net.Socket.prototype.connect = trap("net.Socket.connect");
globalThis.fetch = trap("fetch");
globalThis.WebSocket = class { constructor() { trap("WebSocket")(); } };
if (globalThis.EventSource) globalThis.EventSource = class { constructor() { trap("EventSource")(); } };
syncBuiltinESMExports();
