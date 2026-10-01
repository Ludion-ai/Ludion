// PRS-2 (±): Mandate v0 (spec §10.6). A Principal's passkey consent at the Registry issues a
// Mandate; at real Node Gates, a checkout inside its scope and limits passes, and one out of
// scope, over a limit, past its expiry, withdrawn, for another site, or carried by another Diver
// is refused. The consent itself holds: an assertion that approves other bytes, comes from another
// page or relying party, lacks user verification, is replayed, or is made by another passkey issues
// nothing. The passkey is a software authenticator (passkey.mjs), as the oracle allows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateRegistryKey, signJws } from "@ludion/gate-core/staple";
import { MANDATE_TYP } from "@ludion/gate-core/mandate";
import { memoryLedger } from "@ludion/gate-core";
import { withLudion, ludion } from "@ludion/gate-workers";
import { registryServer, site, agent, directoryHost, testClock, ISSUER } from "./world.mjs";
import { softPasskey, principal } from "./passkey.mjs";

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } } });

const SHOP = "https://shop.example";
const ROUTES = [
  { match: "/checkout/**", pressure: 2, require: { scope: "checkout" } },
  { match: "/account/**", pressure: 2, require: { scope: "account" } },
];
const LIMITS = { checkout_max: 50_000, currency: "JPY", per_day: 3 };

async function waitFor(pred, limitMs) {
  const t = performance.now();
  while (!pred()) {
    if (performance.now() - t > limitMs) return Infinity;
    await new Promise((r) => setTimeout(r, 5));
  }
  return performance.now() - t;
}

async function world() {
  const clock = testClock();
  const reg = await registryServer({ now: () => clock.now(), sseRetryMs: 200 });
  cleanups.push(() => reg.close());
  const directory = directoryHost();
  const registryKeys = reg.registry.publicKeys;
  // One site, one record of what each Mandate spent: every Gate of shop.example shares it (PRS-3).
  const shopLedger = memoryLedger();
  const common = { clock, registryKeys, directory, routes: ROUTES };
  const S = await site({ ...common, host: "shop.example", mandateLedger: shopLedger, revocations: { url: `${reg.url}/v0/revocations/stream`, retryMs: 200, maxRetryMs: 1000 } });
  const U = await site({ ...common, host: "shop.example", mandateLedger: shopLedger }); // the same site on a Gate that does not subscribe
  const O = await site({ ...common, host: "other.example", categories: ["ecommerce"], mandateLedger: memoryLedger() });
  // One Gate in front of two sites (e.g. a shared reverse proxy): both authorities are its own.
  const M = await site({ ...common, host: "admin.example", authorities: ["shop.example", "admin.example"], mandateLedger: shopLedger });
  cleanups.push(() => S.close(), () => U.close(), () => O.close(), () => M.close());
  const [A, B] = await Promise.all(["A", "B"].map((name) => agent({ registryUrl: reg.url, clock, directory, name: `PRS-2 ${name}` })));
  const P = principal({ registryUrl: reg.url, now: () => clock.now(), passkey: await softPasskey({ alg: -7 }) });
  const Q = principal({ registryUrl: reg.url, now: () => clock.now(), passkey: await softPasskey({ alg: -8, counting: false }) });
  for (const p of [P, Q]) assert.equal((await p.register()).status, 201, "a Principal registers a passkey");
  assert.notEqual(await waitFor(() => S.gate.health.revocations.state === "open", 5000), Infinity, "S is subscribed to the revocation stream");
  return { clock, reg, directory, S, U, O, M, A, B, P, Q, shopLedger };
}

/** A checkout of `total` (minor units) by agent `x` at Gate `g`, carrying `mandate`. */
async function checkout(g, x, { mandate, total = 12_000, currency = "JPY", path = "/checkout/1", withStaple = true } = {}) {
  const url = `${path}?total=${total}&currency=${currency}`;
  return g.send(url, await x.headers(g.host, path, { method: "POST", mandate, withStaple }), "POST");
}
const passed = (r) => r.status === 200 && r.body.class === "VERIFIED" && r.body.charge?.ok === true && r.body.charge.enforced === true;
// The reason: the site's refusal of a charge names it; a refusal by the Gate's middleware carries
// only the error, and the reason is read from the Gate's classification of that request.
const refused = (r, error, reason) => r.status !== 200 && r.error === error && (!reason || (r.refusal?.reason ?? r.cls?.mandateError) === reason)
  && r.link === `<https://ludion.ai/e/${error}>; rel="help"`;

test("PRS-2: inside scope and limits a checkout passes; out of scope, over a limit, expired, withdrawn, elsewhere or another Diver's is refused", { timeout: 180_000 }, async () => {
  const { clock, reg, directory, S, U, O, M, A, B, P, Q, shopLedger } = await world();
  const counts = { passed: 0, refused: 0 };
  const yes = (r, what) => { assert.ok(passed(r), `${what}: ${JSON.stringify({ status: r.status, error: r.error, body: r.body, refusal: r.refusal })}`); counts.passed++; };
  const no = (r, error, reason, what) => { assert.ok(refused(r, error, reason), `${what}: expected ${error}${reason ? `/${reason}` : ""}, got ${JSON.stringify({ status: r.status, error: r.error, refusal: r.refusal, body: r.body })}`); counts.refused++; };

  // ── + in scope, within limits ────────────────────────────────────────────────────────────
  const t0 = Math.floor(clock.now() / 1000);
  let r = await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["read", "checkout"], limits: LIMITS, exp: t0 + 2 * 86_400 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const M1 = r.body.mandate;
  const m1 = JSON.parse(Buffer.from(M1.split(".")[1], "base64url").toString());
  assert.deepEqual({ sub: m1.sub, aud: m1.aud, scope: m1.scope, limits: m1.limits }, { sub: A.store.diver_id, aud: SHOP, scope: ["read", "checkout"], limits: LIMITS });
  assert.match(m1.prn, /^pw-[a-z2-7]{52}$/, "the Principal appears as a pairwise pseudonym");
  assert.equal(JSON.parse(Buffer.from(M1.split(".")[0], "base64url").toString()).typ, MANDATE_TYP);

  for (let i = 0; i < 3; i++) yes(await checkout(S, A, { mandate: M1, total: 50_000 - i }), `checkout ${i + 1} of per_day 3 at the limit`);
  // per_day is the site's, not each Gate's (Codex audit #4; PRS-3): the 4th charge is refused at the other Gate too.
  no(await checkout(U, A, { mandate: M1 }), "mandate_scope", "per_day", "the same Mandate at another Gate of the site, past per_day");

  // ── the same, at a Workers site configured only by its file config (@ludion/gate-workers) ─
  {
    const app = { async fetch(request) {
      const q = new URL(request.url).searchParams;
      const v = await ludion(request)?.charge({ amount: Number(q.get("total")), currency: q.get("currency") });
      if (v && !v.ok) return new Response(JSON.stringify({ error: v.error, reason: v.reason }), { status: v.status, headers: { ...v.headers, "content-type": "application/json" } });
      return Response.json({ class: ludion(request)?.cls.class ?? null, charge: v ?? null });
    } };
    const env = { LUDION: { site_id: "site-workers", authorities: ["shop.example"], routes: ROUTES, registry: { keys: reg.registry.publicKeys.keys, issuer: ISSUER } } };
    const worker = withLudion(app, { mandateLedger: shopLedger }); // the same site: the same record
    const realFetch = globalThis.fetch; // the Worker discovers keys over fetch; here the agents' directories are in memory
    globalThis.fetch = async (url, init) => (/\/\.well-known\/http-message-signatures-directory$/.test(String(url)) ? directory.fetch(String(url)) : realFetch(url, init));
    try {
      const w = async (x, { mandate, total = 12_000, currency = "JPY" } = {}) => {
        const res = await worker.fetch(new Request(`https://shop.example/checkout/9?total=${total}&currency=${currency}`,
          { method: "POST", headers: await x.headers("shop.example", "/checkout/9", { method: "POST", mandate }) }), env, { waitUntil() {} });
        const body = await res.json();
        return { status: res.status, error: res.headers.get("ludion-error"), link: res.headers.get("link"),
          body: res.status === 200 ? body : null, refusal: res.status === 200 ? null : body, cls: null };
      };
      const MW = (await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS })).body.mandate; // M1 has spent its per_day
      yes(await w(A, { mandate: MW }), "Workers: a checkout within the Mandate");
      no(await w(A, { mandate: M1 }), "mandate_scope", "per_day", "Workers: the site's count holds here too");
      no(await w(A, { mandate: MW, total: 50_001 }), "mandate_scope", "over_limit", "Workers: over checkout_max");
      no(await w(A), "mandate_required", null, "Workers: no Mandate");
      no(await w(A, { mandate: (await Q.mandate({ sub: B.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS })).body.mandate }), "invalid_signature", null, "Workers: another Diver's Mandate");
    } finally { globalThis.fetch = realFetch; }
  }

  // ── − out of scope, over a limit ─────────────────────────────────────────────────────────
  no(await checkout(S, A, { mandate: M1 }), "mandate_scope", "per_day", "a 4th checkout within 24 h");
  no(await checkout(U, A, { mandate: M1, total: 50_001 }), "mandate_scope", "over_limit", "one yen over checkout_max");
  no(await checkout(U, A, { mandate: M1, currency: "USD", total: 100 }), "mandate_scope", "currency", "another currency");
  no(await checkout(U, A, { mandate: M1, total: 0 }), "mandate_scope", "bad_amount", "a zero amount");
  no(await checkout(U, A, {}), "mandate_required", null, "no Mandate at all");
  r = await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["read", "account"] });
  assert.equal(r.status, 201);
  const Mread = r.body.mandate;
  no(await checkout(U, A, { mandate: Mread }), "mandate_scope", null, "a Mandate without checkout");
  r = await U.send("/account/orders", await A.headers(U.host, "/account/orders", { mandate: Mread }));
  assert.ok(r.status === 200 && r.body.mandate, "the same Mandate opens the route its scope names");
  counts.passed++;

  // ── − elsewhere, another Diver's, forged, without a Staple ───────────────────────────────
  r = await P.mandate({ sub: A.store.diver_id, aud: "https://other.example", scope: ["checkout"], limits: LIMITS });
  const Mother = r.body.mandate;
  no(await checkout(S, A, { mandate: Mother }), "mandate_required", "audience", "a Mandate for another site");
  yes(await checkout(O, A, { mandate: Mother }), "…which holds at that site");
  // The audience is the site the request is for, not any site the Gate fronts: at a Gate whose
  // authorities are shop.example and admin.example, a Mandate for shop.example holds on
  // shop.example and not on admin.example (Codex audit #6).
  r = await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS });
  const Mshop = r.body.mandate;
  const asShop = { ...M, host: "shop.example", send: (p, h, m) => M.send(p, h, m, "shop.example") };
  yes(await checkout(asShop, A, { mandate: Mshop }), "a two-site Gate: the Mandate on the site it names");
  no(await checkout(M, A, { mandate: Mshop }), "mandate_required", "audience", "a two-site Gate: the same Mandate on its other site");
  const prnOther = JSON.parse(Buffer.from(Mother.split(".")[1], "base64url").toString()).prn;
  assert.notEqual(prnOther, m1.prn, "one Principal, two sites: two pseudonyms");
  r = await P.mandate({ sub: A.store.diver_id, aud: "cat:ecommerce", scope: ["checkout"], limits: LIMITS });
  yes(await checkout(O, A, { mandate: r.body.mandate }), "a category Mandate at a site in that category");
  no(await checkout(S, A, { mandate: r.body.mandate }), "mandate_required", "audience", "a category Mandate at a site not in it");

  r = await Q.mandate({ sub: B.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS });
  const MB = r.body.mandate;
  yes(await checkout(S, B, { mandate: MB }), "B with its own Mandate");
  no(await checkout(S, A, { mandate: MB }), "invalid_signature", null, "A carrying B's Mandate is SPOOFED");
  const forger = await generateRegistryKey();
  const forged = await signJws((await crypto.subtle.importKey("jwk", forger.privateJwk, { name: "Ed25519" }, false, ["sign"])), reg.registry.publicKeys.keys[0].kid, MANDATE_TYP,
    { ...m1, jti: "mdt-forgedforgedforged", limits: { ...LIMITS, checkout_max: 10_000_000 } });
  no(await checkout(U, A, { mandate: forged, total: 9_000_000 }), "invalid_signature", null, "a Mandate the Registry did not sign");
  no(await checkout(U, A, { mandate: A.staple.staple }), "invalid_signature", null, "a Staple passed off as a Mandate");
  no(await checkout(U, A, { mandate: M1, withStaple: false }), "mandate_required", "no_staple", "a Mandate with no Staple to say whose it is");

  // ── − withdrawn: at once where the Gate subscribes, within a Staple's life everywhere ─────
  r = await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS });
  const M4 = r.body.mandate, j4 = r.body.jti;
  yes(await checkout(S, A, { mandate: M4 }), "before it is withdrawn (S)");
  yes(await checkout(U, A, { mandate: M4 }), "before it is withdrawn (U)");
  const oldStaple = A.staple;
  const tRevoke = performance.now();
  r = await Q.revoke(j4);
  assert.equal(r.status, 403, "another Principal cannot withdraw it"); assert.equal(r.body.error, "not_your_mandate");
  r = await P.revoke(j4);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const liveMs = await waitFor(() => S.gate.revocations.match({ mandate: j4 }), 60_000);
  assert.ok(liveMs <= 60_000, "the subscribed Gate hears within 60 s");
  const heardMs = performance.now() - tRevoke;
  no(await checkout(S, A, { mandate: M4 }), "mandate_required", "revoked", "withdrawn, at the subscribed Gate");
  assert.equal(S.gate.revocations.match({ sub: A.store.diver_id }), undefined, "withdrawing a Mandate does not revoke the Diver");
  // Another of A's Mandates with charges left (M1 spent its per_day across the site's Gates).
  const M5 = (await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS })).body.mandate;
  yes(await checkout(U, A, { mandate: M5, total: 1 }), "A's other Mandate still holds");
  yes(await checkout(U, A, { mandate: M4 }), "the Gate that does not subscribe still takes it with A's old Staple (the Staple's life is the bound)");
  await A.refresh();
  assert.ok(JSON.parse(Buffer.from(A.staple.staple.split(".")[1], "base64url").toString()).mrev.includes(j4), "a fresh Staple lists the withdrawn Mandate");
  no(await checkout(U, A, { mandate: M4 }), "mandate_required", "revoked", "withdrawn, at the Gate that does not subscribe, once A carries a fresh Staple");
  clock.advanceTo((oldStaple.exp + 31) * 1000);
  A.staple = oldStaple;
  no(await checkout(U, A, { mandate: M4 }), "staple_expired", null, "and the old Staple is over within the hour");
  await A.refresh();
  no(await checkout(U, A, { mandate: M4 }), "mandate_required", "revoked", "so the withdrawal reaches every Gate within one Staple lifetime");

  // ── − expired; and per_day is 24 hours, not forever ──────────────────────────────────────
  const t1 = Math.floor(clock.now() / 1000);
  r = await P.mandate({ sub: A.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS, exp: t1 + 120 });
  const Mshort = r.body.mandate;
  yes(await checkout(U, A, { mandate: Mshort }), "a two-minute Mandate, inside its two minutes");
  clock.advanceTo((t1 + 120 + 31) * 1000);
  await Promise.all([A.refresh(), B.refresh()]);
  no(await checkout(U, A, { mandate: Mshort }), "mandate_required", "expired", "the same Mandate after its expiry");
  clock.advanceTo((t0 + 86_400 + 60) * 1000);
  await A.refresh();
  yes(await checkout(S, A, { mandate: M1 }), "per_day counts the last 24 hours: a day later M1 charges again");
  clock.advanceTo((t0 + 2 * 86_400 + 60) * 1000);
  await A.refresh();
  no(await checkout(S, A, { mandate: M1 }), "mandate_required", "expired", "and after its two days, M1 is over");

  // ── humans: the checkout is theirs, whatever the Mandate rules say ───────────────────────
  r = await S.send("/checkout/1?total=99999999&currency=XXX", { "user-agent": "Mozilla/5.0" }, "POST");
  assert.ok(r.status === 200 && r.body.class === "UNKNOWN" && r.body.charge.ok === true && r.body.charge.enforced === false, "a human's checkout is never held to a Mandate");

  // ── the Registry keeps no site ───────────────────────────────────────────────────────────
  const state = JSON.stringify(reg.registry.store.state);
  for (const s of ["shop.example", "other.example", "cat:ecommerce", "checkout_max"]) assert.ok(!state.includes(s), `the Registry's state holds no ${s}`);

  console.log(`PRS-2: ${counts.passed} checkouts passed, ${counts.refused} refused; withdrawal heard by the subscribed Gate in ${heardMs.toFixed(0)} ms, by the others within one Staple (≤ 3600 s)`);
});

test("PRS-2: a Mandate is issued only on the Principal's own, fresh passkey consent to exactly those terms", { timeout: 60_000 }, async () => {
  const { reg, A, P, Q } = await world();
  const terms = { sub: A.store.diver_id, aud: SHOP, scope: ["checkout"], limits: LIMITS };
  const refusedWith = async (p, status, error, what, o) => {
    const r = await p.mandate(terms, o);
    assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, error, what);
    assert.equal(r.body.mandate, undefined, `${what}: nothing issued`);
  };
  const other = await P.passkey.otherKey();
  await refusedWith(P, 401, "bad_consent", "signed by another key", { bend: { signWith: other } });
  await refusedWith(P, 401, "bad_consent", "made on another page", { bend: { origin: "https://evil.example" } });
  await refusedWith(P, 401, "bad_consent", "made for another relying party", { bend: { rpId: "evil.example" } });
  await refusedWith(P, 401, "bad_consent", "no user verification", { bend: { flags: 0x01 } });
  await refusedWith(P, 401, "bad_consent", "no user presence", { bend: { flags: 0x04 } });
  await refusedWith(P, 401, "bad_consent", "a registration, not an assertion", { bend: { type: "webauthn.create" } });
  await refusedWith(P, 401, "bad_consent", "in a cross-origin frame", { bend: { crossOrigin: true } });
  await refusedWith(P, 401, "bad_consent", "terms raised after consent", { edit: (t) => t.replace('"checkout_max":50000', '"checkout_max":5000000') });
  await refusedWith(P, 401, "unknown_credential", "a passkey nobody registered", { bend: { id: Buffer.alloc(32, 7).toString("base64url") } });
  await refusedWith(P, 400, "stale_request", "a consent from ten minutes ago", { edit: (t) => t.replace(/"iat":\d+/, (m) => `"iat":${Number(m.slice(6)) - 600}`) });

  const good = await P.consent(terms);
  let r = await P.send(good);
  assert.equal(r.status, 201, "the untouched consent issues a Mandate");
  r = await P.send(good);
  assert.ok(r.status === 401 && r.body.mandate === undefined, "replayed, it issues nothing (P's passkey counts: the counter has not moved)");
  // A synced passkey often never counts (always 0): there, only the single-use challenge stops a replay.
  const goodQ = await Q.consent({ ...terms, sub: A.store.diver_id });
  assert.equal((await Q.send(goodQ)).status, 201);
  r = await Q.send(goodQ);
  assert.equal(r.status, 409, "replayed, it issues nothing (Q's passkey does not count)"); assert.equal(r.body.error, "consent_replayed");
  // The Registry now holds P's counter from that consent; an assertion from behind it is a clone.
  await refusedWith(P, 401, "bad_consent", "a counter that went back (a cloned passkey)", { bend: { signCount: 1 } });

  r = await Q.mandate({ ...terms, scope: ["checkout"], limits: undefined });
  assert.equal(r.body.error, "bad_limits", "a checkout Mandate carries limits");
  r = await Q.mandate({ ...terms, scope: ["checkout", "launch_missiles"] });
  assert.equal(r.body.error, "bad_scope", "scope is the v0 vocabulary");
  r = await Q.mandate({ ...terms, exp: Math.floor(Date.now() / 1000) + 8 * 86_400 });
  assert.equal(r.body.error, "bad_expiry", "at most 7 days");
  r = await Q.mandate({ ...terms, aud: "http://shop.example" });
  assert.equal(r.body.error, "bad_audience", "a site is an https origin");

  r = await fetch(`${reg.url}/v0/principals`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: { ...Q.passkey.credential, id: P.passkey.credential.id } }) });
  assert.equal(r.status, 409, "a registered passkey is never replaced by another key");
  await A.client.revoke(A.store, A.root, { reason: "compromised" });
  r = await P.mandate(terms);
  assert.equal(r.status, 403, "no Mandate for a revoked Diver"); assert.equal(r.body.error, "revoked");
});
