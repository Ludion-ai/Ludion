# @ludion/scan

The engine behind `npx ludion scan`: reads access logs (nginx, Apache, Caddy, Cloudflare Logpush, Vercel, AWS ALB, CloudFront, Fastly, IIS; gzip included) and counts which automation touched which routes. Output holds no raw IP, no query value and no untemplated path, and it makes no network call.

```sh
npx ludion scan /var/log/nginx/access.log --json
```

Docs: https://ludion.ai · License: Apache-2.0
