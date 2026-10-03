# ludion/gate/node

The Ludion Gate for Node.js servers: Express, Connect, and anything that takes `(req, res, next)` middleware. It verifies Web Bot Auth (RFC 9421) signatures, classifies automated traffic, and applies your Pressure policy. Humans are never affected.

## Install (60 seconds)

```sh
npm install ludion
```

Add two lines to your server:

```js
import { ludion } from "ludion/gate/node";
app.use(await ludion());
```

Put `ludion.config.json` next to your `package.json`:

```json
{
  "site_id": "site-your-shop",
  "pressure": 0
}
```

Pressure 0 only observes. Nothing changes for anyone until you raise it.

Mount the Gate **before** any body parser (`express.json()`, `multer`, …). When an agent signs a request's `Content-Digest`, the Gate reads the body to check it against that digest, then hands every byte back to your parser. It never parses the body and never sends it anywhere. A body that is over 1 MiB (`maxBodyBytes`), or that something read before the Gate did, cannot be checked, so the request is not `VERIFIED`.

## Configuration

`ludion.config.json` takes the shape of spec §11.4. Unknown keys are an error, so a typo can't silently mean Pressure 0.

```json
{
  "site_id": "site-your-shop",
  "pressure": 0,
  "routes": [
    { "match": "/checkout/**", "pressure": 2, "require": { "depth": 2 } },
    { "match": "/login", "pressure": 2, "require": { "depth": 1 } }
  ],
  "report": { "endpoint": "https://collector.example/events", "send_metadata": true },
  "fail_mode": { "pressure_0_1": "open", "pressure_2_3": "closed" },
  "authorities": ["your-shop.example", "*.your-shop.example"],
  "trust_proxy": false
}
```

- **`site_id`** (required): your site's identifier.
- **`pressure`**: the site-wide Pressure, from 0 (observe) to 3 (everything). Default 0.
- **`routes`**: per-path overrides. Critical routes usually sit at 2 while the rest of the site stays at 0. `require` may ask for a `depth`, `ballast: "active"`, and a Mandate `scope` (`read`, `account`, `post`, `reserve`, `checkout`, `delete`; see [Mandates](#mandates-payments-on-someones-behalf)).
- **`report.endpoint`**: where the Gate POSTs each closed hour's counts, per route template, method, class, decision and operator (ADR-038). No visit leaves: no times, IP hashes, countries, bodies, cookies or query values. Each visit's record stays on the site for 7 days (`app.use` middleware's `.gate.records`; default in memory).
- **`report.send_metadata`**: `false` keeps everything on the site.
- **`fail_mode`**: what a fault inside the Gate does. Pressure 0–1 always stays open. Pressure 2–3 follows `pressure_2_3`.
- **`authorities`**: your site's own hosts (`host`, `host:port`, `*.subdomain`, or an origin). A signature made for any other site is refused, so it can't be replayed here. Needed before Pressure 2–3 routes let verified agents through; without it, those routes treat a verified request as a Gate fault and follow `fail_mode` (ADR-023).
- **`trust_proxy`**: read the client IP and host from `X-Forwarded-*`. Enable it only behind your own proxy.
- **`registry`**: the Ludion Registry's public keys, pinned, as served at its `/.well-known/ludion-keys`: `{ "keys": [...], "issuer": "https://registry.ludion.ai", "revocations": "<stream URL>" }`. Without them the Gate can't read Staples (Depth, Ballast) or Mandates. Public keys only: a private key here is refused. `revocations` subscribes a long-running server to the revocation stream.
- **`categories`**: Mandate categories your site belongs to (for example `["ecommerce"]`). A Mandate for `cat:ecommerce` then holds here too.

**Environment variables**

- **`LUDION_SITE_KEY`**: the Glass receipt signing key, a private Ed25519 JWK. Keep it in your secret store, never in the config file. Without it, an ephemeral key is generated at startup, and the receipts verify only while that process runs.
- **`LUDION_CONFIG`**: a different config file path.

## Mandates (payments on someone's behalf)

A route can ask agents for a Mandate: the Principal's signed delegation, with a scope and limits (spec §10.6).

```json
{ "match": "/checkout/**", "pressure": 2, "require": { "scope": "checkout" } }
```

The Gate checks the Mandate an agent sends: its signature, the Diver it names, your site, its expiry, and whether it was withdrawn. An agent without one gets `403 mandate_required`, and one whose Mandate lacks the scope gets `403 mandate_scope`.

The amount is yours to give: the Gate reads a body only to check a signed `Content-Digest`, and never parses it. Where your handler knows the cart total, charge it:

```js
app.post("/checkout/:id", async (req, res) => {
  const total = cartTotal(req);                        // an integer in the currency's minor unit (JPY: yen, USD: cents)
  const v = await req.ludion.charge({ amount: total, currency: "JPY" });
  if (!v.ok) return res.status(v.status).set(v.headers).json({ error: v.error, reason: v.reason });
  // … take the payment
});
```

`charge` holds the payment to the Mandate's `checkout_max` and `currency` on any Gate. It only applies where the route asks for a scope at Pressure 2 or higher, and never to humans: for them it always returns `{ ok: true, enforced: false }`.

A Mandate's `per_day` is your site's, counted once across all of its Gates over the last 24 hours. Tell the Gate where that record is, in `ludion.config.json`:

- `"mandate_ledger": "memory"`: this process is your site's only Gate.
- `"mandate_ledger": { "sqlite": "ludion-ledger.db" }`: several processes on one machine. Every one names the same file (Node 22.13 or later).
- More machines: pass your own `{ shared: true, async charge(mandate, { at }) }` to `ludionGate({ mandateLedger })`. It must check and record in one atomic step, in a database all your Gates reach.

Without a ledger, a charge on a Mandate with `per_day` is refused (`mandate_scope`, reason `no_shared_ledger`): nothing could count it for the whole site. A Mandate with a limit this Gate cannot enforce (anything but `checkout_max`, `currency` and `per_day`, such as a daily total) is refused too (reason `unenforceable_limit`), with a ledger or without. The Registry never holds what anyone spends.

## Lower level

`ludionGate(config)` takes a `GateConfig` object directly (gate-core's, bundled inside `ludion`).
