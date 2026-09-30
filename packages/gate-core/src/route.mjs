// Routes (spec §11.7, §11.8). What a path is allowed to become when it leaves the site, and
// what kind of thing the request came to do. Shared by the Gate (receipts, metadata, the daily
// report) and by `ludion scan`, so both count the same "critical route" the same way.
//
// Runtime-neutral: no Node APIs, no crypto.

/** A segment that may stay literal: a word, optionally with a file extension. */
const WORD = /^[._]?[A-Za-z][A-Za-z_-]{0,31}(?:\.[A-Za-z0-9]{1,8})?$/;
const VERSION = /^v\d{1,3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

function decode(seg) {
  if (!seg.includes("%")) return seg;
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** Letters-only strings that are still identifiers: very long, or random-looking mixed case. */
function randomLetters(seg) {
  const word = seg.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  if (word.length >= 20 && !/[-_]/.test(word)) return true;
  if (word.length >= 12 && !/[-_]/.test(word)) {
    const upper = (word.match(/[A-Z]/g) ?? []).length;
    if (upper >= 4 && word.length - upper >= 4) return true;
  }
  return false;
}

/**
 * One path segment → itself if it is a plain word, else a placeholder. Anything that could be
 * an identifier (numbers, UUIDs, emails, hex, tokens, encoded text, handles) never stays.
 * @param {string} seg raw segment as it appeared in the request target
 */
export function templateSegment(seg) {
  if (!seg) return seg;
  const d = decode(seg);
  if (/^\d+$/.test(d)) return ":id";
  if (UUID.test(d)) return ":uuid";
  if (d.includes("@")) return EMAIL.test(d) ? ":email" : ":handle";
  if (/^[0-9a-f]{8,}$/i.test(d) && /\d/.test(d)) return ":hex";
  if (/^[A-Za-z0-9_-]{16,}$/.test(d) && /\d/.test(d)) return ":token";
  if (d === seg && (VERSION.test(seg) || (WORD.test(seg) && !randomLetters(seg)))) return seg;
  return ":param";
}

/**
 * Route template for a request target: query and fragment dropped, every segment templated.
 * Absolute-form targets (`http://host/path`) are reduced to their path.
 * @param {string} target
 */
export function templatePath(target) {
  const p = pathOf(target) ?? "";
  return p.split("/").map(templateSegment).join("/");
}

/** The path of a request target, or null when it has none (`*`, authority-form, garbage). */
export function pathOf(target) {
  if (typeof target !== "string" || !target) return null;
  let t = target;
  if (!t.startsWith("/")) {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(.*)$/.exec(t);
    if (!m) return null;
    t = m[1] || "/";
    if (!t.startsWith("/")) t = `/${t}`;
  }
  const cut = t.search(/[?#]/);
  return cut >= 0 ? t.slice(0, cut) : t;
}

/** Query parameter names of a target (never values). */
export function queryKeys(target) {
  if (typeof target !== "string") return [];
  const q = target.indexOf("?");
  if (q < 0) return [];
  const end = target.indexOf("#", q);
  return target.slice(q + 1, end < 0 ? undefined : end).split("&").filter(Boolean)
    .map((kv) => decode(kv.split("=")[0]).toLowerCase());
}

// ── route kinds (spec §11.8: browse, search, login, form, checkout) ─────────────────────────
// The deepest path segment that names a kind decides (`/account/login` is a login,
// `/api/cart/add` is checkout). Otherwise a search query key makes it a search; otherwise
// `/api/…` is api; static files are asset; everything else is browse. No path at all is
// malformed.

export const ROUTE_KINDS = ["checkout", "login", "signup", "account", "form", "search", "api", "asset", "browse", "malformed"];

/** Kinds that are critical routes by themselves (spec §11.3 Pressure 2: 決済・ログイン・投稿). */
export const CRITICAL_KINDS = new Set(["checkout", "login", "signup", "account"]);

/** State-changing methods: any of them is a critical touch, whatever the route (投稿). */
export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const KIND_WORDS = {
  checkout: ["checkout", "cart", "carts", "basket", "bag", "order", "orders", "pay", "payment", "payments", "purchase",
    "billing", "subscription", "subscriptions", "donate"],
  login: ["login", "logon", "signin", "sign-in", "log-in", "logout", "auth", "oauth", "oauth2", "sso", "session", "sessions",
    "token", "password", "reset-password", "forgot-password", "lost-password", "2fa", "mfa", "otp", "wp-login", "xmlrpc"],
  signup: ["signup", "sign-up", "register", "registration", "join", "create-account", "enroll"],
  account: ["account", "accounts", "my-account", "my", "me", "mypage", "profile", "settings", "dashboard", "wallet",
    "addresses", "preferences", "admin", "wp-admin", "administrator"],
  form: ["contact", "inquiry", "enquiry", "apply", "application", "submit", "comment", "comments", "review", "reviews",
    "feedback", "newsletter", "subscribe", "reservation", "reservations", "booking", "bookings", "reserve", "quote", "rsvp",
    "wp-comments-post"],
  search: ["search", "find"],
};
const WORD_KIND = new Map(Object.entries(KIND_WORDS).flatMap(([k, ws]) => ws.map((w) => [w, k])));
const SEARCH_KEYS = new Set(["q", "query", "search", "keyword", "keywords", "s", "k", "term"]);
const API_FIRST = new Set(["api", "graphql", "wp-json", "rest", "rpc"]);
const ASSET_FIRST = new Set(["static", "assets", "_next", "images", "img", "fonts", "css", "js", "media", "build", "dist"]);
const ASSET_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|pdf|zip|gz|wasm)$/i;
const PAGE_EXT = /\.(php|aspx?|html?|jsp|do|cgi|json|xml)$/i;

/**
 * @param {string} method
 * @param {string} target request target as logged (path + query, or absolute-form)
 * @returns {string} one of ROUTE_KINDS
 */
export function routeKind(method, target) {
  const p = pathOf(target);
  if (p == null) return "malformed";
  const segs = p.split("/").filter(Boolean).map((s) => decode(s).toLowerCase());
  for (let i = segs.length - 1; i >= 0; i--) {
    const k = WORD_KIND.get(segs[i].replace(PAGE_EXT, ""));
    if (k) return k;
  }
  if (queryKeys(target).some((k) => SEARCH_KEYS.has(k))) return "search";
  if (segs.length && (API_FIRST.has(segs[0]) || VERSION.test(segs[0]) || segs.includes("graphql"))) return "api";
  if (ASSET_EXT.test(p) || (segs.length && ASSET_FIRST.has(segs[0]))) return "asset";
  return "browse";
}

/** A critical touch: a critical kind, or any write (spec §11.3). */
export function isCritical(method, kind) {
  return CRITICAL_KINDS.has(kind) || WRITE_METHODS.has(String(method ?? "").toUpperCase());
}

// ── route vocabulary ──────────────────────────────────────────────────────────────────────
// Words that name routes on ordinary sites (shops, ticketing, listings, CMSs, frameworks, APIs).
// Where a route must be shown to someone other than the site (scan output, reports), only these
// words stay literal; every other segment becomes :param. A crawled profile such as
// /users/zelda is then /users/:param no matter how often bots fetched it.
const COMMON_WORDS = [
  // pages
  "about", "about-us", "company", "team", "careers", "jobs", "job", "press", "news", "blog", "blogs", "post", "posts",
  "article", "articles", "stories", "story", "page", "pages", "pricing", "plans", "features", "faq", "faqs", "help",
  "support", "docs", "documentation", "guide", "guides", "terms", "privacy", "legal", "policy", "policies", "cookies",
  "sitemap", "robots", "feed", "rss", "atom", "index", "home", "default", "main", "landing", "events", "event", "tickets",
  "ticket", "calendar", "schedule", "venues", "venue", "tag", "tags", "category", "categories", "topics", "topic",
  "archive", "archives", "author", "authors", "users", "user", "members", "member", "people", "u", "p", "c", "t", "s",
  "share", "files", "file", "download", "downloads", "upload", "uploads", "media", "gallery", "photos", "videos", "video",
  "unsubscribe", "confirm", "verify", "activate", "invite", "invites", "reset", "callback", "redirect", "out", "go", "link",
  "links", "embed", "widget", "widgets", "preview", "print", "amp", "health", "healthz", "status", "ping", "metrics",
  "well-known", "manifest", "security", "ads", "humans", "apple-app-site-association", "assetlinks",
  // commerce, listings
  "shop", "store", "stores", "products", "product", "items", "item", "catalog", "collections", "collection", "brands",
  "brand", "deals", "deal", "sale", "offers", "offer", "coupon", "coupons", "gift-cards", "wishlist", "compare",
  "shipping", "returns", "track", "tracking", "invoice", "invoices", "receipt", "receipts", "listings", "listing",
  "properties", "property", "rentals", "rooms", "hotels", "flights", "travel", "tours", "recipes", "menu", "locations",
  "location", "branches", "jobs-search", "results",
  // CMS / frameworks / static
  "wp-content", "wp-includes", "wp-json", "wp", "themes", "theme", "plugins", "plugin", "wp-cron", "cgi-bin",
  "static", "assets", "_next", "data", "chunks", "images", "image", "img", "icons", "icon", "fonts", "font", "css", "js",
  "scripts", "styles", "build", "dist", "public", "vendor", "lib", "favicon", "logo", "apple-touch-icon", "app", "bundle",
  "cdn-cgi", "_vercel", "insights", "_astro", "_nuxt", "graphql", "api", "rest", "rpc", "v", "items", "edit", "new",
  "create", "update", "delete", "add", "remove", "list", "view", "show", "detail", "details", "info", "config", "admin-ajax",
  "ajax", "webhook", "webhooks", "events-api", "auth-callback", "authorize", "consent", "userinfo", "jwks", "openid-configuration",
];
const ROUTE_WORDS = new Set([...Object.values(KIND_WORDS).flat(), ...COMMON_WORDS]);
const FILE_EXT = /^(php|html?|aspx?|jsp|do|cgi|js|mjs|css|json|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|map)$/i;

/** Is this literal segment a known route word (optionally `word.ext`, optionally with a `.` prefix)? */
export function isRouteWord(seg) {
  const s = seg.toLowerCase().replace(/^\./, "");
  if (ROUTE_WORDS.has(s) || VERSION.test(s)) return true;
  const dot = s.lastIndexOf(".");
  return dot > 0 && FILE_EXT.test(s.slice(dot + 1)) && ROUTE_WORDS.has(s.slice(0, dot));
}

/**
 * The strict template for routes shown off-site: templatePath, then every literal that is not a
 * route word → :param.
 */
export function publicTemplateSegment(seg) {
  const t = templateSegment(seg);
  return !t || t.startsWith(":") || isRouteWord(t) ? t : ":param";
}
