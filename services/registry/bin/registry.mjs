#!/usr/bin/env node
// ludion-registry — run the Registry v0 on Node.
//
//   node services/registry/bin/registry.mjs --key registry-key.json [--state registry.json]
//        [--host 127.0.0.1] [--port 8787] [--origin https://registry.example] [--issuer URL]
//        [--scheme http] [--staple-lifetime 3600] [--sse-retry-ms 2000]
//
// The signing key is a production secret (spec §10.3 "Registry Intermediate", in an HSM): make it
// offline and pass it with --key. This program never generates one on disk. For development only,
// --dev-ephemeral-key makes a throwaway key in memory, and --dev-verified-contacts treats every
// contact as confirmed (D1); both say so on stderr.
// On start it prints one JSON line: {"listening": "<url>", "kid": "<registry key id>"}.
import fs from "node:fs";
import http from "node:http";
import { createRegistry } from "../src/index.mjs";
import { nodeListener, createFileStore } from "../src/node.mjs";
import { generateRegistryKey } from "@ludion/gate-core/staple";

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(`--${name}`);

let key;
if (flag("key")) key = JSON.parse(fs.readFileSync(flag("key"), "utf8"));
else if (has("dev-ephemeral-key")) {
  key = (await generateRegistryKey()).privateJwk;
  process.stderr.write("⚠ ludion-registry: DEV MODE — an ephemeral signing key held in memory only. Staples it issues die with this process.\n");
} else {
  process.stderr.write("✖ the Registry signing key is a production secret: generate it offline and pass --key <private-jwk.json> (or --dev-ephemeral-key for development).\n");
  process.exit(2);
}
if (has("dev-verified-contacts")) process.stderr.write("⚠ ludion-registry: DEV MODE — every registered contact is treated as confirmed (depth 1).\n");

const registry = await createRegistry({
  key,
  store: flag("state") ? createFileStore(flag("state")) : undefined,
  issuer: flag("issuer"),
  origin: flag("origin"),
  stapleLifetimeS: flag("staple-lifetime") ? Number(flag("staple-lifetime")) : undefined,
  sseRetryMs: flag("sse-retry-ms") ? Number(flag("sse-retry-ms")) : undefined,
  contactsVerified: has("dev-verified-contacts"),
});
const server = http.createServer(nodeListener(registry, { scheme: flag("scheme", "https") }));
server.listen(Number(flag("port", 8787)), flag("host", "127.0.0.1"), () => {
  const { address, port } = server.address();
  const host = address.includes(":") ? `[${address}]` : address;
  process.stdout.write(`${JSON.stringify({ listening: `http://${host}:${port}`, kid: registry.publicKeys.keys[0].kid })}\n`);
});
const stop = () => { registry.close(); server.close(); server.closeAllConnections?.(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
