// One Gate process for PRS-3: a real gate-node server whose Mandate ledger is the SQLite file the
// test names, shared with the other processes. Prints "READY <port>". Config arrives as JSON in
// LUDION_PRS3 (Registry public key, the agent's directory, the ledger file).
import http from "node:http";
import { ludionGate, sqliteLedger } from "@ludion/gate-node";
import { generateSiteKey } from "@ludion/gate-core";

const c = JSON.parse(process.env.LUDION_PRS3);
const mw = await ludionGate({
  siteId: "site-prs3", siteKey: (await generateSiteKey()).privateJwk, authorities: ["shop.example"],
  routes: [{ match: "/checkout/**", pressure: 2, require: { scope: "checkout" } }],
  registryKeys: { keys: [c.registry] }, registryIssuer: c.issuer,
  mandateLedger: await sqliteLedger(c.ledger),
  resolver: { fetch: async () => new Response("", { status: 404 }) },
});
await mw.gate.resolver.prime({ type: "directory", uri: c.agentUri }, { keys: [c.agentKey] });
const srv = http.createServer((req, res) => mw(req, res, async () => {
  const q = new URL(req.url, "http://x").searchParams;
  const v = await req.ludion.charge({ amount: Number(q.get("total")), currency: q.get("currency") });
  res.writeHead(v.ok ? 200 : v.status, { "content-type": "application/json", ...(v.headers ?? {}) });
  res.end(JSON.stringify({ ok: v.ok, enforced: v.enforced, reason: v.reason ?? null, remaining: v.remaining ?? null }));
}));
srv.listen(0, "127.0.0.1", () => console.log(`READY ${srv.address().port}`));
