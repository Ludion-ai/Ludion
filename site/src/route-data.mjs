// Starlight builds canonical, hreflang and og:url from the output file name, which ends in ".html"
// under build.format "preserve". The public URLs have no extension (e.g. /e/signature_required,
// the exact URL every Gate denial links to), so say those.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

const strip = (u) => u.replace(/\.html$/, "").replace(/\/index$/, "/");

export const onRequest = defineRouteMiddleware((context) => {
  for (const entry of context.locals.starlightRoute.head) {
    const a = entry.attrs ?? {};
    if (entry.tag === "link" && (a.rel === "canonical" || a.rel === "alternate") && typeof a.href === "string") a.href = strip(a.href);
    if (entry.tag === "meta" && a.property === "og:url" && typeof a.content === "string") a.content = strip(a.content);
  }
});
