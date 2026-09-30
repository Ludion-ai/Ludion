// Host for workerd (wrangler dev): GET /run runs the portable suite and the conformance vectors and
// answers the JSON result.
import { run, test } from "./shim.mjs";
import "./suite.mjs";
import { registerConformance } from "./conformance.mjs";
import vectors from "./vectors.json" with { type: "json" };

registerConformance(vectors, { test });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("ready");
    return Response.json({ ...(await run({ runtime: "workerd" })), version: globalThis.navigator?.userAgent ?? "workerd" });
  },
};
