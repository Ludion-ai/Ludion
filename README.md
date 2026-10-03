# Ludion

**A neutral checkpoint that verifies AI agents' accountability, on [Web Bot Auth](https://datatracker.ietf.org/wg/webbotauth/about/) ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)).**

Agents now browse, compare, log in, book and buy on people's behalf. A site that receives one cannot answer three questions:

1. **Whose agent is it?** (the Principal)
2. **What is it allowed to do?** (the Mandate)
3. **Who answers if it breaks something?** (Ballast)

Web Bot Auth lets an agent sign its requests, and that tells a site which operator signed. Ludion builds the rest on top of it:

- **For sites: the Gate.** A free, open-source checkpoint that runs inside your site. It verifies signatures, classifies automated traffic, and first just shows you which agents came and what they touched. People never see a difference.
- **For agents: the Diver.** A free identity. One registration gives an agent a signature, its status (a Staple) and delegations (Mandates), which it carries everywhere it goes.
- **When something breaks: Ballast.** It backs who answers for the agent. What Ludion verifies is accountability, not detection and not identity.

## Try it

**See what is hitting your site.** Drop an access log on [ludion.ai/scan](https://ludion.ai/scan). The page counts how much unverified automation touched your checkout, login, signup and forms. The log is read in your browser and never sent anywhere. It takes nginx, Apache, Caddy, IIS, CloudFront, AWS ALB, Cloudflare Logpush, Vercel and Fastly logs, gzip included. No log at hand? The page has a sample.

**Put the Gate in front, at Pressure 0.** Pressure 0 only observes: nothing changes for anyone until you raise it.

```sh
npm install @ludion/gate-node
```

```js
import { ludion } from "@ludion/gate-node";
app.use(await ludion());
```

```json
{ "site_id": "site-your-shop", "pressure": 0 }
```

That JSON goes in `ludion.config.json`, next to `package.json`. Next.js and Cloudflare Workers are covered at [ludion.ai/gate](https://ludion.ai/gate). Every refusal the Gate can give links to a page that explains it: [ludion.ai/e](https://ludion.ai/e).

**Give your agent an identity.**

```sh
npx ludion init --name "My Agent" --contact mailto:ops@example.com
npx ludion sign GET https://example.com/
```

`init` writes your keys and the key directory to publish at your agent's origin. `sign` prints the Web Bot Auth headers for any HTTP client.

> The packages are not on npm yet. Until they are, everything runs from this repository (`npm ci`, then the examples below).

## What works today

| | |
|---|---|
| **Scan** (`ludion scan`, [/scan](https://ludion.ai/scan)) | Nine log formats, detected without flags. Counts DECLARED, SUSPECTED and signed-but-unverifiable automation, and the requests that touched critical routes. Prints templates (`/orders/:id`), never addresses or query values. |
| **Gate** (Node/Express, Next.js, Workers) | Verifies Web Bot Auth signatures with key discovery. Classes: VERIFIED, UNVERIFIED, SPOOFED, REVOKED, DECLARED, SUSPECTED. Pressure 0–3, per route. Signed receipts (Glass). Mandates with the site's own limits. Metadata-only events (spec §11.7). |
| **Daily report** (`ludion report`) | Yesterday's numbers from the Gate's events, in Japanese and English, HTML and text. |
| **Diver** (`ludion init / sign / rotate / doctor`) | Root and Session keys (the Root key sealed with a passphrase), the key directory and Card, request signing. |
| **Registry v0** ([`services/registry`](services/registry)) | Registration, Staples, Mandate consent with passkeys, revocation and its stream. A reference service: there is no hosted Registry yet. |

Ballast v0 is a set of commitments, not insurance. Ludion does not offer Ballast v1 yet.

## How it is built

Ludion is built against verifiers. Progress means a row on the scoreboard turning to PASS, not someone saying it works.

- [`docs/MISSION.md`](docs/MISSION.md) lists the oracles: what must be true, each paired with a negative ("the real thing passes, a fake does not").
- [`accept/registry.mjs`](accept/registry.mjs) runs them, and `npm run scoreboard` prints the board.
- A ratchet (`npm run ratchet`) pins every oracle that has passed. CI refuses a change that breaks one.
- The product's intent is [`docs/ludion-spec.md`](docs/ludion-spec.md) (Japanese). Its §8 lists the invariants. Decisions are recorded in [`docs/adr/`](docs/adr).

```sh
npm ci
npm test            # seconds
npm run scoreboard  # minutes: every oracle
node examples/e2e.mjs   # an agent, a Gate, VERIFIED, all on 127.0.0.1
```

## Repository

| Path | What |
|---|---|
| `packages/gate-core` | The Gate: verification, classification, Pressure, receipts, Mandates. Runtime-neutral. |
| `packages/gate-node`, `gate-next`, `gate-workers` | The Gate for Node servers, Next.js (`proxy.js`) and Cloudflare Workers |
| `packages/scan` | The log scan, shared by the CLI and the browser |
| `packages/report` | The daily report |
| `packages/diver`, `packages/ludion` | The agent side and the `ludion` CLI |
| `packages/card-host` | Serves a Diver's key directory and Card |
| `services/registry` | Registry v0 |
| `site` | ludion.ai (Astro + Starlight), English and Japanese |
| `accept` | The oracles, attack corpus, conformance vectors and fixtures |
| `reference` | Reference shops (Express, Next.js, Workers) the Gate is installed into |
| `pilots` | The Gate in front of real sites |

## Principles

- **Neutral.** No dependency on any particular CDN, AI lab, cloud or payment network. The Gate runs in the site's own infrastructure.
- **Open.** The spec, the Gate and the SDKs are open source. Only the operation (the Registry) is Ludion's.
- **Content never leaves the site.** The Gate sends metadata only: no bodies, cookies or query values.
- **Properties over identity.** A site learns what it needs ("Depth 2, Ballast active, may check out up to ¥50,000"), not who is behind the agent.
- **No home-made cryptography.** Ed25519 through WebCrypto, RFC 9421 through the Web Bot Auth reference implementation.

## License and security

Apache-2.0 ([LICENSE](LICENSE)). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
