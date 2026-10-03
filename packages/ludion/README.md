# ludion

Give your AI agent its own key and name, and read them at your site. One package: the CLI and the Gate.

## For an agent: `npx ludion`

```sh
npx ludion init --name "My Agent" --contact mailto:ops@example.com
npx ludion sign GET https://example.com/   # Web Bot Auth (RFC 9421) headers for curl, httpx, anything
npx ludion doctor
npx ludion revoke                          # take the identity offline
```

- `init` writes `./ludion.json`. The Root key is sealed with your passphrase (`LUDION_ROOT_PASSPHRASE`); `--dev` stores it in plaintext and says so.
- From code: `import { ludionFetch } from "ludion/diver";` signs requests for you.

## For a site: the Gate

```sh
npm install ludion
```

| Runtime | In your app |
|---|---|
| Node (Express, Connect) | `import { ludion } from "ludion/gate/node";` then `app.use(await ludion());` |
| Next.js 16+ (`proxy.js`) | `export { proxy } from "ludion/gate/next";` |
| Cloudflare Workers | `import { withLudion } from "ludion/gate/workers";` then `export default withLudion({ fetch })` |

The settings go in `ludion.config.json` (`{ "site_id": "site-your-shop", "pressure": 0 }` to start: Pressure 0 only observes). Each runtime's page: https://ludion.ai/gate

## Your logs: `npx ludion scan`

```sh
npx ludion scan access.log   # what automation touched which routes; nothing leaves your machine
```

It reads nginx, Apache, Caddy, Cloudflare Logpush, Vercel, AWS ALB, CloudFront, Fastly and IIS logs, gzip included.

Docs: https://ludion.ai · Source: https://github.com/Ludion-ai/Ludion · License: Apache-2.0
