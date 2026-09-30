// Preload (`node --import`) for PRIV-1/PRIV-2: records every byte this process could send out.
//   fetch            recorded in full (URL, method, headers, body) and served from an in-memory map
//                    of public key documents (globalThis.__egress.docs); anything else is a 404
//   net/tls/http(s)/http2/dgram/dns/child_process   recorded with their arguments, then refused
//   fs writes        recorded with path and data, then refused
//   stdout/stderr    recorded (and passed through)
// On exit the log is written to $LUDION_EGRESS_LOG with the functions saved before patching.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const LOG = process.env.LUDION_EGRESS_LOG;
if (!LOG) throw new Error("LUDION_EGRESS_LOG not set");
const writeLog = fs.writeFileSync.bind(fs);

const records = [];
const meta = {};
const text = (v) => {
  if (v == null) return v;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v).toString("latin1");
  try { return JSON.stringify(v); } catch { return String(v); }
};
const safeArgs = (args) => args.map((a) => (typeof a === "function" ? "[function]" : text(a)));

globalThis.__egress = {
  docs: new Map(),                                  // url → { body, type }
  record: (entry) => records.push(entry),
  meta: (k, v) => { meta[k] = v; },
};

globalThis.fetch = async function recordedFetch(input, init = {}) {
  const url = String(input instanceof Request ? input.url : input);
  const req = new Request(url, { ...init, signal: undefined });
  const body = init.body == null ? null : await new Response(init.body).text();
  records.push({ ch: "fetch", url, method: req.method, headers: [...req.headers], body });
  const doc = globalThis.__egress.docs.get(url);
  return doc ? new Response(JSON.stringify(doc.body), { status: 200, headers: { "content-type": doc.type ?? "application/json" } })
    : new Response("", { status: 404 });
};

function refuse(name) {
  return function refused(...args) {
    records.push({ ch: name, args: safeArgs(args) });
    throw new Error(`egress refused by the PRIV trap: ${name}`);
  };
}
const TARGETS = {
  net: ["connect", "createConnection"],
  tls: ["connect"],
  http: ["request", "get"],
  https: ["request", "get"],
  http2: ["connect"],
  dgram: ["createSocket"],
  dns: ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "reverse"],
  child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
  fs: ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "write", "writeSync"],
};
for (const [mod, fns] of Object.entries(TARGETS)) {
  const m = require(mod);
  for (const f of fns) if (typeof m[f] === "function") m[f] = refuse(`${mod}.${f}`);
}
for (const f of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  const dnsp = require("dns").promises;
  if (dnsp?.[f]) dnsp[f] = refuse(`dns.promises.${f}`);
}
for (const f of ["writeFile", "appendFile"]) fs.promises[f] = refuse(`fs.promises.${f}`);
require("net").Socket.prototype.connect = refuse("net.Socket.connect");
globalThis.WebSocket = class { constructor(...a) { refuse("WebSocket")(...a); } };
syncBuiltinESMExports();

for (const stream of ["stdout", "stderr"]) {
  const s = process[stream], orig = s.write.bind(s);
  s.write = (chunk, ...rest) => { records.push({ ch: stream, data: text(chunk) }); return orig(chunk, ...rest); };
}

process.on("exit", () => { writeLog(LOG, JSON.stringify({ records, meta })); });
