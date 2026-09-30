# @ludion/registry

The Ludion Registry v0 (spec §13): Diver registration, session-key approval, Staples, revocation and the revocation stream. It is **never on the request hot path**: agents carry their state (Staples), and Gates verify it with the Registry's pinned public keys. If the Registry goes down, the world keeps verifying until Staples expire (REG-1).

**The Registry never learns where an agent goes.** No endpoint takes a site, a URL or a path, and Staples are refreshed on a timer, not per request (PRIV-3).

Fetch API only (`registry.fetch(Request) → Response`), so the same code runs on Node, workerd, Deno and Bun. See ADR-025 for the design.

## API

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/.well-known/ludion-keys` | — | The Registry's public keys (JWKS). Gates pin these. |
| POST | `/v0/divers` | Root statement `ludion-register+jwt` | Register a Diver: Root public key, Signature-Agent origin, contacts, Ballast v0 commitments. |
| POST | `/v0/divers/{id}/keys` | Root statement `ludion-keys+jwt` | Approve the session keys the Diver may sign with. Replaces the set; ordered by `ts`, so an older approval cannot roll it back. |
| POST | `/v0/divers/{id}/staple` | RFC 9421 signature by an approved session key (`@method @path @authority content-digest`) | Issue a Staple (≤ 1 h), `cnf.jkt` bound to the asking key. A revoked Diver gets a `revoked: true` Staple. |
| POST | `/v0/revocations` | Root statement `ludion-revoke+jwt` | Revoke the Diver, or only some session keys (`scope: "keys"`). |
| GET | `/v0/revocations?since=N` | — | Revocation entries after `N`, each a Registry-signed JWS (`ludion-revocation+jwt`). |
| GET | `/v0/revocations/stream` | — | The same, live, as Server-Sent Events. Resumes from `Last-Event-ID` or `?since=`. |

Root statements are compact JWS (EdDSA), and their `iat` must be within 5 minutes of now.

## Run it (development)

```bash
node services/registry/bin/registry.mjs --dev-ephemeral-key --port 8787 --scheme http
# {"listening":"http://127.0.0.1:8787","kid":"…"}
```

In production, the signing key is made offline and held by a human, in an HSM. Pass it with `--key <private-jwk.json>`. The Registry never generates one on disk. Use `--state registry.json` to keep state across restarts.

## A Diver talks to it

```bash
npx ludion register --registry https://registry.example   # Root: register + approve the session key, then fetch a Staple
npx ludion staple                                          # refresh the Staple (session key)
npx ludion rotate                                          # registered: the next key is approved before it is published
npx ludion revoke --compromised                            # Root: revoke this Diver
```

From code, use `createRegistryClient` and `createStapleKeeper` from `@ludion/diver`. The keeper refreshes the Staple at half its lifetime.

## A Gate subscribes

```js
await ludionGate({ …, registryKeys, revocations: { url: "https://registry.example/v0/revocations/stream" } });
```

Entries are verified with `registryKeys`. Revoked keys, agents and Divers become REVOKED within seconds (REG-3).
