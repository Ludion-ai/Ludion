# @ludion/gate-core

The runtime-neutral core of the Ludion Gate: verifies Web Bot Auth (RFC 9421) signatures, classifies each request (VERIFIED, SPOOFED, UNVERIFIED, DECLARED, SUSPECTED, UNKNOWN) and applies the site's Pressure. Humans are never touched.

Most sites install an adapter instead: `@ludion/gate-node` (Node, Express), `@ludion/gate-next` (Next.js) or `@ludion/gate-workers` (Cloudflare Workers).

```js
import { createGate } from "@ludion/gate-core";
const gate = await createGate({ siteId: "site-my-shop", siteKey, authorities: ["shop.example"] });
const { cls, decision, headers } = await gate.inspect(requestDescriptor);
```

Writing your own adapter: when `bodyNeeded(requestDescriptor)` is true (a signature covers `content-digest`), set `requestDescriptor.body` to the bytes that arrived, or `{ unavailable: "<reason>" }` if you could not read them. Without it, such a request is not `VERIFIED`. `readWebBody(request)` does this for a Web `Request` without consuming it.

Docs: https://ludion.ai · License: Apache-2.0
