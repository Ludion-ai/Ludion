// Fetch for source checks that can only reach public addresses.
// The name is resolved inside the connection's own lookup, checked there, and the socket connects to exactly
// the checked address. There is no second resolution, so DNS rebinding cannot swap in a private address.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { FetchFn } from "@ludion/core";

const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}

// IPv6: only global unicast (2000::/3) is public. That excludes ::1, ::, fc00::/7, fe80::/10, multicast,
// IPv4-mapped (::ffff:0:0/96), and NAT64 (64:ff9b::/96). Inside 2000::/3, block the special ranges.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["2001::", 23], // IETF protocol assignments, Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, embeds an IPv4 address
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !blockedV4.check(address, "ipv4");
    case 6:
      return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
    default:
      return false;
  }
}

export class BlockedAddressError extends Error {
  readonly code = "ERR_LUDION_BLOCKED_ADDRESS";
  constructor(hostname: string, address: string) {
    super(`${hostname} resolves to ${address}, which is not a public address`);
  }
}

type LookupOptions = { family?: number | string; hints?: number; all?: boolean };
type Resolver = (hostname: string, options: { all: true }, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const systemResolver: Resolver = (hostname, options, callback) => dnsLookup(hostname, options, callback);

/**
 * A `lookup` for net/tls connect. Resolves every address, refuses the name if any one is not public,
 * and hands back the checked addresses, as an array when called with `all: true` (Happy Eyeballs) or as one otherwise.
 */
export function guardedLookup(resolve: Resolver = systemResolver, allowed: (address: string) => boolean = isPublicAddress) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    // On error the address is ignored; pass an empty one to satisfy net's callback type.
    const fail = (e: NodeJS.ErrnoException) => callback(e, options.all ? [] : "");
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return fail(err);
      const family = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
      const usable = family ? addresses.filter((a) => a.family === family) : addresses;
      if (usable.length === 0) return fail(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }));
      const bad = addresses.find((a) => !allowed(a.address));
      if (bad) return fail(new BlockedAddressError(hostname, bad.address));
      if (options.all) return callback(null, usable);
      callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

export function createSafeFetch(lookup = guardedLookup()): FetchFn {
  const dispatcher = new Agent({ connect: { lookup } });
  return (url, init) => undiciFetch(url, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
}
