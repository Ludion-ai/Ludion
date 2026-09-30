// The Gate's side of revocation (spec §10.10): the list classify() reads, and the stream subscriber.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRevocationList, subscribeRevocations } from "@ludion/gate-core/revocation";
import { createStapleVerifier, REVOCATION_TYP } from "@ludion/gate-core";
import { generateRegistryKey, importRegistryKey, signJws } from "@ludion/gate-core/staple";

const ISS = "https://registry.ludion.ai";
const K1 = "a".repeat(43), K2 = "b".repeat(43);

test("revocation list: a Diver entry revokes its Diver id, its keys and its Signature-Agent; a key entry only its keys", () => {
  const l = createRevocationList();
  l.add({ seq: 1, sub: "dvr-aaaaaaaaaaaaaaaa", scope: "diver", jkt: [K1], agent: "https://dvr-aaaaaaaaaaaaaaaa.agents.ludion.ai", reason: "compromised" });
  l.add({ seq: 2, sub: "dvr-bbbbbbbbbbbbbbbb", scope: "keys", jkt: [K2] });
  assert.equal(l.match({ sub: "dvr-aaaaaaaaaaaaaaaa" })?.seq, 1);
  assert.equal(l.match({ jkt: K1 })?.seq, 1);
  assert.equal(l.match({ identifier: "https://dvr-aaaaaaaaaaaaaaaa.agents.ludion.ai/.well-known/http-message-signatures-directory" })?.seq, 1);
  assert.equal(l.match({ jkt: K2 })?.seq, 2);
  assert.equal(l.match({ sub: "dvr-bbbbbbbbbbbbbbbb" }), undefined, "a key revocation leaves the Diver standing");
  assert.equal(l.match({ sub: "dvr-cccccccccccccccc", jkt: "c".repeat(43), identifier: "https://other.example/x" }), undefined);
  assert.equal(l.lastSeq, 2);
  assert.equal(l.add({ seq: 3 }), false, "an entry without a subject is ignored");
});

/** A fake Registry stream: each connection gets the frames of `script(n, lastEventId)`. */
function fakeStream(script) {
  const calls = [];
  const fetch = async (url, init) => {
    const n = calls.length;
    calls.push({ url, headers: init.headers });
    const frames = await script(n, init.headers["last-event-id"]);
    if (frames === null) throw new TypeError("fetch failed");
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) { for (const f of frames) { c.enqueue(enc.encode(f)); await new Promise((r) => setTimeout(r, 1)); } c.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, calls };
}

test("revocation stream: verified entries apply, forged ones are rejected, reconnects resume from the last seq, nothing throws", async () => {
  const key = await generateRegistryKey();
  const signing = await importRegistryKey(key.privateJwk);
  const verifier = await createStapleVerifier({ keys: [key.publicJwk] }, { issuer: ISS });
  const forger = await importRegistryKey((await generateRegistryKey()).privateJwk);
  const entry = (k, seq, sub) => signJws(k.privateKey, k.kid, REVOCATION_TYP, { iss: ISS, seq, sub, scope: "diver", jkt: [], iat: 1 });
  const e1 = await entry(signing, 1, "dvr-aaaaaaaaaaaaaaaa");
  const forged = await entry(forger, 2, "dvr-bbbbbbbbbbbbbbbb");
  const staple = await signJws(signing.privateKey, signing.kid, "ludion-staple+jwt", { iss: ISS, seq: 3, sub: "dvr-dddddddddddddddd" });
  const e4 = await entry(signing, 4, "dvr-cccccccccccccccc");
  const s = fakeStream(async (n) => {
    if (n === 0) return ["retry: 10\r\n\r\n", ": ping\n\n", `id: 1\nevent: revocation\ndata: ${e1}\n\n`, `id: 2\nevent: revocation\ndata: ${forged}\n\n`, `id: 3\nevent: revocation\ndata: ${staple}\n\n`];
    if (n === 1) return null; // the Registry is unreachable once
    return [`id: 4\r\nevent: revocation\r\ndata: ${e4}\r\n\r\n`];
  });
  const list = createRevocationList();
  const sub = subscribeRevocations({ url: "https://registry.test/v0/revocations/stream", fetch: s.fetch, list, retryMs: 10, maxRetryMs: 50,
    verify: (c) => verifier.verifyStatement(c, { typ: REVOCATION_TYP }) });
  for (let i = 0; i < 200 && !list.match({ sub: "dvr-cccccccccccccccc" }); i++) await new Promise((r) => setTimeout(r, 5));
  sub.stop();
  assert.ok(list.match({ sub: "dvr-aaaaaaaaaaaaaaaa" }), "a Registry-signed entry applies");
  assert.equal(list.match({ sub: "dvr-bbbbbbbbbbbbbbbb" }), undefined, "an entry signed by another key does not");
  assert.equal(list.match({ sub: "dvr-dddddddddddddddd" }), undefined, "a Staple is not a revocation entry");
  assert.ok(list.match({ sub: "dvr-cccccccccccccccc" }), "after a failed reconnect, the stream resumed");
  assert.equal(sub.status.rejected, 2);
  assert.equal(s.calls[2].headers["last-event-id"], "1", "resumed from the last applied entry");
  assert.match(s.calls[2].url, /[?&]since=1$/);
  assert.equal(s.calls[0].headers["last-event-id"], undefined);
  assert.deepEqual(Object.keys(s.calls[0].headers).sort(), ["accept"], "the subscription carries nothing about any visitor");
  assert.equal(sub.status.state, "stopped");
});
