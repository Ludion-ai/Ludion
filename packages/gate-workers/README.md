# ludion/gate/workers

The Ludion Gate for Cloudflare Workers, as a wrapper around your fetch handler. It runs in your own Cloudflare account, and Ludion's neutrality holds (spec §11.2). It verifies Web Bot Auth (RFC 9421) signatures, classifies automated traffic, and applies your Pressure policy. Humans are never affected.

## Install (60 seconds)

```sh
npm install ludion
```

Wrap your default export. That is three lines: the import, `withLudion({`, and the closing `});`:

```js
import { withLudion } from "ludion/gate/workers";
export default withLudion({
  async fetch(request, env, ctx) {
    // your Worker, unchanged
  },
});
```

Add the site config to `wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]

[vars.LUDION]
site_id = "site-your-shop"
pressure = 0
```

Pressure 0 only observes. Nothing changes for anyone until you raise it. `nodejs_compat` is needed because the Gate uses `node:crypto` for receipt IDs and IP hashing.

## Notes

- **Signed bodies.** When an agent signs a request's `Content-Digest`, the Gate reads a clone of the body (up to 1 MiB) to check it. Your handler still gets the whole body.
- **Other handlers are kept.** `scheduled`, `queue` and any other members of your default export keep working.
- **Events outlive the response.** Classified events are handed to `ctx.waitUntil`, so they are delivered after the response is returned.
- **Immutable headers.** A response with immutable headers, such as one passed through from `fetch()`, is copied with its body stream intact. Only `Ludion-*` headers are added.
- **Payments on someone's behalf.** Where a route asks for a Mandate (`"require": { "scope": "checkout" }`), your handler holds the payment to its limits once it knows the total:

  ```js
  import { withLudion, ludion } from "ludion/gate/workers";
  // inside fetch(request, env, ctx), with the total in the currency's minor unit:
  const v = await ludion(request)?.charge({ amount: total, currency: "JPY" });
  if (v && !v.ok) return new Response(JSON.stringify({ error: v.error }), { status: v.status, headers: v.headers });
  ```

  Pass the very `Request` your handler received. Humans are never held: for them `charge` returns `{ ok: true, enforced: false }`.

  A Mandate's `per_day` is your site's, counted once across every isolate and Gate. Isolates share no memory, so hand the Gate a ledger they all reach: `withLudion(handler, { mandateLedger })`, where `mandateLedger` is `{ shared: true, async charge(mandate, { at }) }` backed by a Durable Object or a database, and checks and records in one atomic step. Without one, a charge on a Mandate with `per_day` is refused (`mandate_scope`, reason `no_shared_ledger`). The per-charge maximum and the currency hold either way.

## Configuration

The `LUDION` var takes the same keys as `ludion.config.json` in [`ludion/gate/node`](../gate-node/README.md#configuration), as a TOML table or as a JSON string.

Set the receipt key as a secret: `wrangler secret put LUDION_SITE_KEY`.
