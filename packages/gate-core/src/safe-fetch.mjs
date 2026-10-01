// A fetch for key discovery on Node that cannot be pointed into the site's own network
// (Node-only: `@ludion/gate-core/safe-fetch`; every adapter on a Node runtime uses it — gate-node, gate-next)
// (spec §15.2, GATE-6). The Signature-Agent URL is chosen by the requester, so:
//   - the name is resolved once, and EVERY resolved address must be public (isPublicAddress);
//   - the connection goes to exactly the address that was checked (no second resolution, so a
//     DNS answer that changes between check and connect — rebinding — has nothing to change);
//   - redirects are never followed, the body is never decompressed (no gzip bombs) and reading
//     stops at maxBytes; the caller's AbortSignal bounds the whole exchange.
// Returns a WHATWG Response, so gate-core's resolver stays runtime-neutral.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { isPublicAddress } from "./address.mjs";

const nonPublic = (message) => Object.assign(new Error(message), { code: "ERR_LUDION_NON_PUBLIC_ADDRESS" });

/**
 * @param {{
 *   lookup?: typeof dns.lookup,   // name resolution (tests inject one); default dns.lookup
 *   maxBytes?: number,            // stop reading after this many body bytes; default 64 KiB
 *   allowPrivateNetwork?: boolean,// tests only, like the resolver's option of the same name
 *   dial?: (address: string, port: number) => { host: string, port: number }, // tests only: where a checked address is reached
 * }} [options]
 */
export function createSafeFetch({ lookup = dns.lookup, maxBytes = 64 * 1024, allowPrivateNetwork = false, dial } = {}) {
  function resolve(host) {
    const family = net.isIP(host);
    if (family) return Promise.resolve([{ address: host, family }]);
    return new Promise((ok, fail) => {
      lookup(host, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return fail(err);
        ok(Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]);
      });
    });
  }

  return async function safeFetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`unsupported scheme ${url.protocol}`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolve(host);
    if (!addresses.length) throw new Error(`${host} did not resolve`);
    if (!allowPrivateNetwork) {
      for (const a of addresses) if (!isPublicAddress(a.address)) throw nonPublic(`${host} resolves to a non-public address`);
    }
    const address = addresses[0].address;
    const secure = url.protocol === "https:";
    const port = Number(url.port || (secure ? 443 : 80));
    const to = dial ? dial(address, port) : { host: address, port };
    init.signal?.throwIfAborted();

    return new Promise((ok, fail) => {
      const req = (secure ? https : http).request({
        // No `agent`: with any agent (even `agent: false`) Node ignores createConnection and would
        // resolve the name again itself — exactly the second resolution rebinding needs.
        method: "GET", host, port, path: `${url.pathname}${url.search}`, signal: init.signal,
        headers: { ...(init.headers ?? {}), host: url.host, "accept-encoding": "identity" },
        createConnection: () => (secure
          ? tls.connect({ host: to.host, port: to.port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ["http/1.1"] })
          : net.connect({ host: to.host, port: to.port })),
      }, (res) => {
        const chunks = [];
        let n = 0;
        res.on("data", (c) => {
          n += c.length;
          if (n > maxBytes) { req.destroy(); fail(new Error("response too large")); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) return fail(new Error(`unexpected status ${status}`));
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v ?? [])) headers.append(k, String(x));
          ok(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        });
        res.on("error", fail);
      });
      req.on("error", fail);
      req.end();
    });
  };
}
