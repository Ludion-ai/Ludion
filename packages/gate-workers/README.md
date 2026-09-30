# @ludion/gate-workers

The Ludion Gate for Cloudflare Workers, as a wrapper around your fetch handler. It runs in your own Cloudflare account, and Ludion's neutrality holds (spec §11.2). It verifies Web Bot Auth (RFC 9421) signatures, classifies automated traffic, and applies your Pressure policy. Humans are never affected.

## Install (60 seconds)

```sh
npm install @ludion/gate-workers
```

Wrap your default export. That is three lines: the import, `withLudion({`, and the closing `});`:

```js
import { withLudion } from "@ludion/gate-workers";
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

- **Other handlers are kept.** `scheduled`, `queue` and any other members of your default export keep working.
- **Events outlive the response.** Classified events are handed to `ctx.waitUntil`, so they are delivered after the response is returned.
- **Immutable headers.** A response with immutable headers, such as one passed through from `fetch()`, is copied with its body stream intact. Only `Ludion-*` headers are added.

## Configuration

The `LUDION` var takes the same keys as `ludion.config.json` in [`@ludion/gate-node`](../gate-node/README.md#configuration), as a TOML table or as a JSON string.

Set the receipt key as a secret: `wrangler secret put LUDION_SITE_KEY`.
