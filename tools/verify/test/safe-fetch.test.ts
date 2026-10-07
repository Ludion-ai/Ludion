import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSource } from "@ludion/core";
import { BlockedAddressError, createSafeFetch, guardedLookup, isPublicAddress } from "../src/safe-fetch.ts";

type Resolver = Parameters<typeof guardedLookup>[0];

/** A resolver that answers from a script: one list of addresses per call, in order. */
function scripted(...answers: string[][]): Resolver & { calls: number } {
  const r = Object.assign(
    (_host: string, _opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) => {
      const answer = answers[Math.min(r.calls++, answers.length - 1)]!;
      queueMicrotask(() => cb(null, answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))));
    },
    { calls: 0 },
  );
  return r;
}

function lookupOnce(resolve: Resolver, options: { all?: boolean; family?: number } = {}) {
  return new Promise<{ err: Error | null; address?: unknown; family?: number }>((done) =>
    guardedLookup(resolve)("host.example.org", options, (err, address, family) => done({ err, address, family })),
  );
}

describe("isPublicAddress", () => {
  it.each(["93.184.215.14", "8.8.8.8", "2606:4700::6810:84e5", "2a00:1450:4001::200e"])("allows %s", (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });
  it.each([
    "10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "ff02::1",
    "not-an-ip",
  ])("refuses %s", (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });
});

describe("guardedLookup", () => {
  it("refuses a name that resolves to a private address", async () => {
    const r = await lookupOnce(scripted(["10.1.2.3"]));
    expect(r.err).toBeInstanceOf(BlockedAddressError);
  });

  it("refuses a name if even one of its addresses is private", async () => {
    const r = await lookupOnce(scripted(["93.184.215.14", "127.0.0.1"]), { all: true });
    expect(r.err).toBeInstanceOf(BlockedAddressError);
  });

  it("answers with the checked addresses as a list when called with all: true", async () => {
    const r = await lookupOnce(scripted(["93.184.215.14", "2606:4700::6810:84e5"]), { all: true });
    expect(r).toEqual({ err: null, address: [{ address: "93.184.215.14", family: 4 }, { address: "2606:4700::6810:84e5", family: 6 }], family: undefined });
  });

  it("answers with one address otherwise, honoring the family", async () => {
    expect(await lookupOnce(scripted(["93.184.215.14", "2606:4700::6810:84e5"]))).toEqual({ err: null, address: "93.184.215.14", family: 4 });
    expect(await lookupOnce(scripted(["93.184.215.14", "2606:4700::6810:84e5"]), { family: 6 })).toEqual({ err: null, address: "2606:4700::6810:84e5", family: 6 });
  });
});

describe("createSafeFetch", () => {
  let server: Server;
  let port: number;
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers.host ?? "");
      res.writeHead(200, { "content-type": "text/plain" }).end("hello from the pinned address");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it("makes verify fail for a name that resolves to a private address", async () => {
    const safeFetch = createSafeFetch(guardedLookup(scripted(["10.1.2.3"])));
    const r = await checkSource("https://intranet-alias.example.org/", "anything here", safeFetch);
    expect(r).toEqual({ found: false, reason: expect.stringContaining("resolves to 10.1.2.3, which is not a public address") });
  });

  it("connects to exactly the address the lookup checked", async () => {
    // Allow loopback only in this test, to observe where the socket goes. pinned.example.org has no real DNS.
    const safeFetch = createSafeFetch(guardedLookup(scripted(["127.0.0.1"]), () => true));
    const res = await safeFetch(`http://pinned.example.org:${port}/`);
    expect(await res.text()).toBe("hello from the pinned address");
    expect(seen.at(-1)).toBe(`pinned.example.org:${port}`);
  });

  it("refuses a name that turns private at connect time, even if an earlier lookup saw a public address", async () => {
    const rebinding = scripted(["93.184.215.14"], ["127.0.0.1"]);
    // A naive pre-check would resolve once and see a public address...
    await new Promise<void>((ok) => rebinding("rebind.example.org", { all: true }, () => ok()));
    const before = seen.length;
    // ...but the connection resolves again inside the guarded lookup, gets 127.0.0.1, and never connects.
    const safeFetch = createSafeFetch(guardedLookup(rebinding));
    const err = await safeFetch(`http://rebind.example.org:${port}/`).then(() => null, (e: Error) => e);
    expect((err?.cause as Error | undefined)?.message).toBe("rebind.example.org resolves to 127.0.0.1, which is not a public address");
    expect(rebinding.calls).toBe(2);
    expect(seen.length).toBe(before);
  });
});
