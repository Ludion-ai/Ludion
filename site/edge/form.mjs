// What the early-access form and its endpoint (./signup.mjs) agree on. The page imports this too,
// so the form posts the names the endpoint reads.
export const ENDPOINT = "/api/signup";
/** The honeypot: hidden from people (display: none), filled by bots that fill every field. */
export const HONEYPOT = "message";
export const ROLES = ["site", "agent", "other"];
export const LANGS = ["en", "ja"];
