// The site on Workers (the preview of WEB-1, WEB-8): the build's static files, and POST /api/signup.
// Workers answers a request for a static file without running this; everything else comes here.
import { ENDPOINT, createLimiter, handleSignup } from "./signup.mjs";

const limiter = createLimiter();

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === ENDPOINT) {
      // Cloudflare sets CF-Connecting-IP to the client's address; a client cannot choose it.
      return handleSignup(request, { webhook: env.SIGNUP_WEBHOOK_URL, client: request.headers.get("cf-connecting-ip") ?? "", limiter });
    }
    return env.ASSETS.fetch(request);
  },
};
