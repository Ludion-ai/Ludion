// Which IP addresses key discovery may connect to (spec §15.2: the Signature-Agent URL is chosen
// by the requester, so discovery must never become a way into the site's own network).
// Only globally routable unicast is public. Everything else — private, loopback, link-local,
// CGNAT, multicast, reserved, documentation, benchmarking, and IPv6 forms that embed or
// translate to such an IPv4 address — is refused. Runtime-neutral: string parsing only.

/** @returns {number[] | null} the four bytes of a dotted-quad IPv4 address */
function v4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

// [a, b, c, d, prefix length]
const V4_NOT_PUBLIC = [
  [0, 0, 0, 0, 8],        // "this network", incl. 0.0.0.0 (connects to the local host on some systems)
  [10, 0, 0, 0, 8],       // private
  [100, 64, 0, 0, 10],    // CGNAT (incl. 100.100.100.200, a cloud metadata address)
  [127, 0, 0, 0, 8],      // loopback
  [169, 254, 0, 0, 16],   // link-local (incl. 169.254.169.254 cloud metadata)
  [172, 16, 0, 0, 12],    // private
  [192, 0, 0, 0, 24],     // IETF protocol assignments
  [192, 0, 2, 0, 24],     // TEST-NET-1
  [192, 88, 99, 0, 24],   // 6to4 relay anycast (deprecated)
  [192, 168, 0, 0, 16],   // private
  [198, 18, 0, 0, 15],    // benchmarking
  [198, 51, 100, 0, 24],  // TEST-NET-2
  [203, 0, 113, 0, 24],   // TEST-NET-3
  [224, 0, 0, 0, 4],      // multicast
  [240, 0, 0, 0, 4],      // reserved, incl. 255.255.255.255
];
const u32 = ([a, b, c, d]) => (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
const inV4 = (ip, [a, b, c, d, len]) => {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return ((u32(ip) & mask) >>> 0) === ((u32([a, b, c, d]) & mask) >>> 0);
};

/** @returns {number[] | null} the eight 16-bit groups of an IPv6 address (brackets and zone allowed) */
function v6(input) {
  let s = input.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const last = s.lastIndexOf(":");
  if (s.slice(last + 1).includes(".")) { // embedded dotted-quad tail
    const b = v4(s.slice(last + 1));
    if (!b) return null;
    s = `${s.slice(0, last + 1)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  let groups;
  if (parts.length === 1) groups = head;
  else {
    const tail = parts[1] ? parts[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

const embedded = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Is this an IP address that key discovery may connect to? Anything that is not an IP address
 * at all is `false`.
 * @param {string} ip
 */
export function isPublicAddress(ip) {
  if (typeof ip !== "string") return false;
  const a = v4(ip);
  if (a) return !V4_NOT_PUBLIC.some((n) => inV4(a, n));
  const g = v6(ip);
  if (!g) return false;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isPublicAddress(embedded(g[6], g[7]));        // ::ffff:a.b.c.d mapped
  if (zeros(0, 6)) return false;                                                          // ::, ::1, ::a.b.c.d (compatible, deprecated)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isPublicAddress(embedded(g[6], g[7])); // ::ffff:0:a.b.c.d translated
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicAddress(embedded(g[6], g[7])); // NAT64 well-known prefix
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false;                       // NAT64 local-use
  if (g[0] === 0x2002) return isPublicAddress(embedded(g[1], g[2]));                      // 6to4
  if (g[0] === 0x2001 && g[1] < 0x0200) return false;                                     // IETF assignments incl. Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;                                   // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;                                     // documentation (RFC 9637)
  if (g[0] === 0x5f00) return false;                                                      // SRv6 SIDs
  return (g[0] & 0xe000) === 0x2000;                                                      // only global unicast 2000::/3
}

/** Is this string an IP address literal (v4 dotted-quad or v6)? */
export function isIpLiteral(s) {
  return typeof s === "string" && (v4(s) !== null || v6(s) !== null);
}
