// POST /api/signup on Vercel Functions (the Web-standard signature): the same endpoint the site's
// Worker runs (../edge/signup.mjs). Vercel answers other methods 405 itself.
import { createLimiter, handleSignup } from "../edge/signup.mjs";

const limiter = createLimiter();

export function POST(request) {
  // Vercel sets X-Real-IP to the client's address.
  return handleSignup(request, { webhook: process.env.SIGNUP_WEBHOOK_URL, client: request.headers.get("x-real-ip") ?? "", limiter });
}
