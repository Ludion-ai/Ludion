// Ludion blog runtime. The blog pages are hand-authored static HTML (prose +
// measured tables), but their chrome — the logo, nav, and footer — is mounted
// here so it reuses the LP's real components (hexMark/githubMark) and the LP's
// --lx-* token system. One source for the chrome means the blog can never drift
// from the landing page. Article body stays in HTML; only the frame is JS.
import "@fontsource/ibm-plex-mono/400.css";
import "./dashboard.css"; // --lx-* tokens + .lx-btn primitives (load before blog.css)
import "./blog.css"; // dark long-form reading styles (consumes --lx-*)
import { el, githubMark, hexMark } from "./dashboard/components";

// Canonical repo URL — same value the LP uses (landing.ts). Kept as a local
// const here rather than imported from landing.ts: that module runs the whole
// landing bootstrap (top-level mount()) on import, which must not happen on a
// blog page.
const REPO = "https://github.com/Ludion-ai/Ludion";

function navLink(
  label: string,
  href: string,
  opts: { current?: boolean } = {},
): HTMLAnchorElement {
  const a = el("a", "blog-nav-link", label);
  a.href = href;
  if (opts.current) a.setAttribute("aria-current", "page");
  return a;
}

/** Shared sticky header: LP brand (hexMark + wordmark) + nav to LP/blog/product.
 * `section` marks which nav item is the current page (the index passes "writing"). */
export function buildBlogHeader(section?: string): HTMLElement {
  const bar = el("header", "blog-topbar");
  const inner = el("div", "blog-topbar-inner");

  const brand = el("a", "blog-brand");
  brand.href = "/";
  brand.setAttribute("aria-label", "Ludion home");
  brand.append(hexMark(), el("span", "blog-brand-word", "Ludion"));

  const nav = el("nav", "blog-nav");
  nav.append(navLink("How it works", "/#how"));
  nav.append(navLink("Writing", "/blog/", { current: section === "writing" }));
  nav.append(navLink("Demo", "/#capability"));

  const gh = el("a", "blog-nav-icon");
  gh.href = REPO;
  gh.target = "_blank";
  gh.rel = "noopener";
  gh.setAttribute("aria-label", "GitHub");
  gh.append(githubMark());
  nav.append(gh);

  const ws = el("a", "lx-btn lx-btn-primary blog-nav-cta", "Workspace");
  ws.href = "/app";
  nav.append(ws);

  inner.append(brand, nav);
  bar.append(inner);
  return bar;
}

/** Shared footer: brand line back to the LP + the public-domain measurements link. */
export function buildBlogFooter(): HTMLElement {
  const f = el("footer", "blog-footer");
  const inner = el("div", "blog-footer-inner");

  const brand = el("a", "blog-foot-brand");
  brand.href = "/";
  brand.append(hexMark(), el("span", "blog-brand-word", "Ludion"));

  const note = el("p", "blog-foot-note");
  note.append(document.createTextNode("Measurements are in "));
  const link = el("a", "blog-foot-link", "bench/results");
  link.href = `${REPO}/tree/main/bench/results`;
  link.target = "_blank";
  link.rel = "noopener";
  note.append(link, document.createTextNode(", released to the public domain."));

  inner.append(brand, note);
  f.append(inner);
  return f;
}

function mount(): void {
  const headerMount = document.querySelector<HTMLElement>("[data-blog-header]");
  if (headerMount) {
    headerMount.replaceWith(buildBlogHeader(headerMount.dataset.blogHeader));
  }
  const footerMount = document.querySelector<HTMLElement>("[data-blog-footer]");
  if (footerMount) {
    footerMount.replaceWith(buildBlogFooter());
  }
}

mount();
