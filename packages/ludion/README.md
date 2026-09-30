# ludion

The Ludion CLI. The same commands as `@ludion/diver`, under the name `npx ludion`.

```sh
npx ludion scan access.log          # what automation touched which routes, from your own logs; nothing leaves your machine
npx ludion init --name "My Agent" --contact mailto:ops@example.com
npx ludion sign GET https://example.com/   # Web Bot Auth (RFC 9421) headers for curl, httpx, anything
npx ludion doctor
```

- `init` writes `./ludion.json`. The Root key is sealed with your passphrase (`LUDION_ROOT_PASSPHRASE`); `--dev` stores it in plaintext and says so.
- `scan` reads nginx, Apache, Caddy, Cloudflare Logpush, Vercel, AWS ALB, CloudFront, Fastly and IIS logs, gzip included.

Docs: https://ludion.ai · Source: https://github.com/Ludion-ai/Ludion · License: Apache-2.0
