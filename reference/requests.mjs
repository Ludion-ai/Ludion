// Unsigned browser traffic for GATE-1: header sets and orders as Chrome 141, Safari 26 and
// Firefox 143 send them over HTTP/1.1 (navigations, subresources, form posts, fetch() calls).
// Every reference app serves the same routes, so one set covers all three.

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";
const SESSION = "session=Qm9vdHN0cmFwLWNvb2tpZQ; theme=light; _ga=GA1.1.1234567890.1759200000";

const chrome = (host, { method = "GET", path, dest = "document", mode = "navigate", site = "none", accept, referer, cookie, extra = [] }) => [
  `${method} ${path} HTTP/1.1`, `Host: ${host}`, "Connection: keep-alive",
  `sec-ch-ua: "Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="8"`, "sec-ch-ua-mobile: ?0", `sec-ch-ua-platform: "Windows"`,
  ...(dest === "document" ? ["Upgrade-Insecure-Requests: 1"] : []),
  `User-Agent: ${CHROME_UA}`,
  `Accept: ${accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"}`,
  `Sec-Fetch-Site: ${site}`, `Sec-Fetch-Mode: ${mode}`, ...(dest === "document" ? ["Sec-Fetch-User: ?1"] : []), `Sec-Fetch-Dest: ${dest}`,
  ...(referer ? [`Referer: ${referer}`] : []),
  "Accept-Encoding: gzip, deflate, br, zstd", "Accept-Language: ja,en-US;q=0.9,en;q=0.8",
  ...(cookie ? [`Cookie: ${cookie}`] : []), ...extra,
];
const safari = (host, { method = "GET", path, dest = "document", mode = "navigate", site = "none", accept, referer, cookie, extra = [] }) => [
  `${method} ${path} HTTP/1.1`, `Host: ${host}`,
  `Accept: ${accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}`,
  `Sec-Fetch-Site: ${site}`, ...(cookie ? [`Cookie: ${cookie}`] : []), "Accept-Encoding: gzip, deflate, br", `Sec-Fetch-Mode: ${mode}`,
  `User-Agent: ${SAFARI_UA}`, ...(referer ? [`Referer: ${referer}`] : []), "Accept-Language: ja-JP,ja;q=0.9", "Priority: u=0, i",
  `Sec-Fetch-Dest: ${dest}`, ...extra, "Connection: keep-alive",
];
const firefox = (host, { method = "GET", path, dest = "document", mode = "navigate", site = "none", accept, referer, cookie, extra = [] }) => [
  `${method} ${path} HTTP/1.1`, `Host: ${host}`, `User-Agent: ${FIREFOX_UA}`,
  `Accept: ${accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}`,
  "Accept-Language: ja,en-US;q=0.7,en;q=0.3", "Accept-Encoding: gzip, deflate, br, zstd", ...extra,
  ...(referer ? [`Referer: ${referer}`] : []), "Connection: keep-alive", ...(cookie ? [`Cookie: ${cookie}`] : []),
  ...(dest === "document" ? ["Upgrade-Insecure-Requests: 1"] : []),
  `Sec-Fetch-Dest: ${dest}`, `Sec-Fetch-Mode: ${mode}`, `Sec-Fetch-Site: ${site}`, ...(dest === "document" ? ["Sec-Fetch-User: ?1"] : []), "Priority: u=0, i",
];
const BROWSERS = { chrome, safari, firefox };

function build(browser, host, o) {
  const body = o.body == null ? null : Buffer.from(o.body);
  const extra = [...(o.extra ?? []), ...(body ? [`Content-Type: ${o.type}`, `Content-Length: ${body.length}`, `Origin: http://${host}`] : [])];
  const lines = BROWSERS[browser](host, { ...o, extra });
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), body ?? Buffer.alloc(0)]);
}

/**
 * The request set, for one server. `stream` marks the response whose timing is checked too.
 * Every server gets the same Host (the site's name, as a browser sends it), whatever port it
 * listens on, so absolute URLs an app derives from Host do not differ between servers.
 */
export function browserRequests(host = "shop.example") {
  const ref = (p) => `http://${host}${p}`;
  const list = [
    ["chrome", "home", { path: "/" }],
    ["safari", "product page", { path: "/products/2", site: "same-origin", referer: ref("/") }],
    ["firefox", "search with a query", { path: "/search?q=la&utm_source=newsletter", site: "same-origin", referer: ref("/") }],
    ["chrome", "stylesheet", { path: "/style.css", dest: "style", mode: "no-cors", site: "same-origin", accept: "text/css,*/*;q=0.1", referer: ref("/") }],
    ["firefox", "image", { path: "/logo.png", dest: "image", mode: "no-cors", site: "same-origin", accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5", referer: ref("/") }],
    ["safari", "login page", { path: "/login", site: "same-origin", referer: ref("/") }],
    ["safari", "login form post", { method: "POST", path: "/login", site: "same-origin", referer: ref("/login"), type: "application/x-www-form-urlencoded", body: "user=ann%40example.test&password=correct+horse" }],
    ["chrome", "account with a session cookie", { path: "/account", site: "same-origin", referer: ref("/login"), cookie: SESSION }],
    ["chrome", "account without a session", { path: "/account", site: "same-origin", referer: ref("/") }],
    ["firefox", "fetch() JSON POST", { method: "POST", path: "/api/cart", dest: "empty", mode: "cors", site: "same-origin", accept: "*/*", referer: ref("/products/2"), cookie: SESSION, type: "application/json", body: JSON.stringify({ items: [{ id: "2", qty: 2 }] }) }],
    ["chrome", "checkout page (critical route)", { path: "/checkout/1", site: "same-origin", referer: ref("/products/1"), cookie: SESSION }],
    ["chrome", "checkout form post (critical route)", { method: "POST", path: "/checkout/1", site: "same-origin", referer: ref("/checkout/1"), cookie: SESSION, type: "application/x-www-form-urlencoded", body: "confirm=1" }],
    ["firefox", "permanent redirect", { path: "/old-home" }],
    ["chrome", "unknown path (404)", { path: "/no/such/page" }],
    ["safari", "unknown product (404)", { path: "/products/99", site: "same-origin", referer: ref("/") }],
    ["chrome", "HEAD of the home page", { method: "HEAD", path: "/" }],
    ["chrome", "streamed response", { path: "/stream", stream: true }],
  ];
  return list.map(([browser, name, o]) => ({ name: `${browser}: ${name}`, browser, stream: !!o.stream, bytes: build(browser, host, o) }));
}

/** A request with the given User-Agent and no browser headers (automation, for live checks). */
export function automationRequest(host, { path = "/", ua = "python-requests/2.32.3", method = "GET" } = {}) {
  return Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${ua}\r\nAccept-Encoding: gzip, deflate\r\nAccept: */*\r\nConnection: close\r\n\r\n`, "latin1");
}
