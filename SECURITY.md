# Security

Ludion is a registry. A registry dies from one breach (DigiNotar, 2011). We design for that.

- Report vulnerabilities to security@ludion.ai. We acknowledge within 24 hours.
- We publish a post-mortem within 72 hours of any confirmed incident affecting keys, Staples, Depth, or site metadata.
- Cryptography: Ed25519 via WebCrypto, RFC 9421 via Cloudflare's `http-message-sig` / `web-bot-auth`. Nothing home-made.
- Known v0 limitations are listed in docs/THREATS.md. Read it before running Pressure ≥ 2 in production.
- Bug bounty starts once 1,000 Gates are live.
