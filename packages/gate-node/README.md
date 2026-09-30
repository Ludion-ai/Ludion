# @ludion/gate-node

The Ludion Gate for Node.js servers: Express, Connect, and anything that takes `(req, res, next)` middleware. It verifies Web Bot Auth (RFC 9421) signatures, classifies automated traffic, and applies your Pressure policy. Humans are never affected.

## Install (60 seconds)

```sh
npm install @ludion/gate-node
```

Add two lines to your server:

```js
import { ludion } from "@ludion/gate-node";
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
  "trust_proxy": false
}
```

- **`site_id`** (required): your site's identifier.
- **`pressure`**: the site-wide Pressure, from 0 (observe) to 3 (everything). Default 0.
- **`routes`**: per-path overrides. Critical routes usually sit at 2 while the rest of the site stays at 0.
- **`report.endpoint`**: where the classified events are POSTed. They carry metadata only (spec §11.7): no bodies, no cookies, no query values, and no raw IPs.
- **`report.send_metadata`**: `false` keeps everything on the site.
- **`fail_mode`**: what a fault inside the Gate does. Pressure 0–1 always stays open. Pressure 2–3 follows `pressure_2_3`.
- **`trust_proxy`**: read the client IP and host from `X-Forwarded-*`. Enable it only behind your own proxy.

**Environment variables**

- **`LUDION_SITE_KEY`**: the Glass receipt signing key, a private Ed25519 JWK. Keep it in your secret store, never in the config file. Without it, an ephemeral key is generated at startup, and the receipts verify only while that process runs.
- **`LUDION_CONFIG`**: a different config file path.

## Lower level

`ludionGate(config)` takes a `GateConfig` object directly. See `@ludion/gate-core`.
