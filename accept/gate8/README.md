# Real signed requests (GATE-8)

Each file in `real/` is one request that a third party's production agent really sent, and the key directory that published its signing key at the time. `gate8.test.mjs` checks the record against its sources, checks the signature apart from the Gate, and then requires the Gate to verify the request as that agent. The same request, tampered with, replayed, late, sent for another site or checked against today's directory, must never verify.

To add one (for example, a request the canary captured, LIVE-2):

- `request`: the method, the target URL, `receivedAt` (ms, when the site received it), and every header exactly as captured, in order. Copy the bytes from the capture. Never retype them.
- `directory`: the directory body, byte for byte, as served or archived then.
- `provenance`: where the request was captured, how, and when you retrieved it. For the directory, give the archived copies. The one whose bytes you stored has `stored: true` and its Wayback CDX digest. Put today's directory under `live`, so the test can show that the key is from then.
- `expect`: `VERIFIED`, the identifier (the directory URL the Gate resolves) and the keyid.
- Keep only what the source itself published. Do not add identifiers that the source redacted.
