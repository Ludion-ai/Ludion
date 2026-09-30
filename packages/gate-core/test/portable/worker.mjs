// Host for workerd (wrangler dev): GET /run runs the portable suite and answers its JSON result.
import { run } from "./shim.mjs";
import "./suite.mjs";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("ready");
    return Response.json({ ...(await run({ runtime: "workerd" })), version: globalThis.navigator?.userAgent ?? "workerd" });
  },
};
