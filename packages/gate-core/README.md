# @ludion/gate-core

The runtime-neutral core of the Ludion Gate: verifies Web Bot Auth (RFC 9421) signatures, classifies each request (VERIFIED, SPOOFED, UNVERIFIED, DECLARED, SUSPECTED, UNKNOWN) and applies the site's Pressure. Humans are never touched.

Most sites install an adapter instead: `@ludion/gate-node` (Node, Express), `@ludion/gate-next` (Next.js) or `@ludion/gate-workers` (Cloudflare Workers).

```js
import { createGate } from "@ludion/gate-core";
const gate = await createGate({ siteId: "site-my-shop", siteKey, authorities: ["shop.example"] });
const { cls, decision, headers } = await gate.inspect(requestDescriptor);
```

Docs: https://ludion.ai · License: Apache-2.0
