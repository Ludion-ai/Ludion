// POST /api/signup — early-access form sink. Zero dependencies.
// Forwards to SIGNUP_WEBHOOK_URL (Slack/Discord incoming webhook) if set; always logs.
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "method" }); }
  let body = req.body ?? {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (body.company_website) return res.status(200).json({ ok: true }); // honeypot field: silently accept
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "email" });
  const role = ["site", "agent", "insurer", "verifier", "other"].includes(body.role) ? body.role : "other";
  const site = /^https?:\/\/\S{1,200}$/.test(String(body.site ?? "")) ? String(body.site) : "";
  const rec = { ts: new Date().toISOString(), email, role, site, country: req.headers["x-vercel-ip-country"] ?? null, lang: (req.headers["accept-language"] ?? "").slice(0, 32) };
  console.log("signup", JSON.stringify(rec));
  const hook = process.env.SIGNUP_WEBHOOK_URL;
  if (hook) {
    const text = `New Ludion signup — ${email} · ${role}${site ? ` · ${site}` : ""}${rec.country ? ` · ${rec.country}` : ""}`;
    try { await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text, record: rec }) }); }
    catch (e) { console.error("webhook failed", e?.message); }
  }
  return res.status(200).json({ ok: true });
}
