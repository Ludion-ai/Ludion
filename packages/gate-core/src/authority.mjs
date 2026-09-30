// The site's own authorities (ADR-023). A signature covers @authority, but the Gate reads the
// authority from the request it received (Host, or X-Forwarded-Host behind a trusted proxy). A
// Gate that does not know which authorities are its own cannot tell a signature made for this
// site from one captured at another site and replayed here with that site's Host.
// Runtime-neutral: WHATWG URL only.

/**
 * `host` or `host:port`, lowercased, without a trailing dot, default ports dropped (URL does
 * that for http/https). null when there is no usable authority.
 * @param {string} targetUri
 */
export function requestAuthority(targetUri) {
  try {
    const u = new URL(targetUri);
    if (!u.hostname) return null;
    const host = u.hostname.replace(/\.$/, "");
    return u.port ? `${host}:${u.port}` : host;
  } catch { return null; }
}

/** One configured entry → { host, port, wildcard } or throws a TypeError naming it. */
function parseEntry(entry) {
  if (typeof entry !== "string" || !entry.trim()) throw new TypeError(`authorities: every entry must be a non-empty string (got ${JSON.stringify(entry)})`);
  let s = entry.trim();
  let wildcard = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new TypeError(`authorities: ${JSON.stringify(entry)} is not a valid origin`); }
    if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
      throw new TypeError(`authorities: ${JSON.stringify(entry)} must be an origin (scheme://host[:port]) with nothing after it`);
    }
    s = u.host;
  }
  if (s.startsWith("*.")) { wildcard = true; s = s.slice(2); }
  let u;
  try { u = new URL(`https://${s}`); } catch { throw new TypeError(`authorities: ${JSON.stringify(entry)} is not a host or host:port`); }
  if (!u.hostname || u.username || u.password || u.pathname !== "/" || u.search || u.hash || s.includes("/") || s.includes("*")) {
    throw new TypeError(`authorities: ${JSON.stringify(entry)} is not a host or host:port`);
  }
  // new URL("https://h:443") drops 443; an explicit :443 means the default port, which is right.
  return { host: u.hostname.replace(/\.$/, ""), port: u.port, wildcard };
}

/**
 * @param {undefined | null | string[] | ((authority: string) => boolean)} spec
 * @returns {{ pinned: boolean, allows(authority: string | null): boolean }}
 *   `allows` throws only when a site-supplied function throws (a fault in the site's config).
 */
export function createAuthorities(spec) {
  if (spec == null) return { pinned: false, allows: () => true };
  if (typeof spec === "function") {
    return { pinned: true, allows: (a) => a != null && spec(a) === true };
  }
  if (!Array.isArray(spec)) throw new TypeError("authorities must be an array of hosts / origins, or a function (authority) => boolean");
  if (!spec.length) throw new TypeError("authorities must not be empty: leave it unset (unpinned) or list the site's hosts");
  const entries = spec.map(parseEntry);
  return {
    pinned: true,
    allows(a) {
      if (a == null) return false;
      const i = a.lastIndexOf(":");
      const bracketed = a.startsWith("[");
      const [host, port] = (i > 0 && (!bracketed || a.lastIndexOf("]") < i)) ? [a.slice(0, i), a.slice(i + 1)] : [a, ""];
      return entries.some((e) => e.port === port && (e.wildcard ? host.endsWith(`.${e.host}`) && host.length > e.host.length + 1 : host === e.host));
    },
  };
}
