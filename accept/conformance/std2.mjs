// STD-2's cases (packages/gate-core/test/std2.test.mjs) for the conformance vectors: each group is
// one STD-2 test, by its exact title, and each step changes exactly one thing from a VERIFIED
// request. The classes are spec §10.8's: a keyid missing from the directory is UNVERIFIED (not
// attributable); anything that fails RFC 9421 / Web Bot Auth verification is SPOOFED. Every Gate
// must answer those classes, not just refuse (`classes` in the vectors).
// GATE-10 fails when std2.test.mjs has a test these groups do not mirror.
import { component } from "http-message-sig";
import { withFields, fieldOf, retarget, AGENT, ATTACKER, SITE, NOW_S, NOW_MS } from "../../packages/gate-core/test/support.mjs";

/**
 * @param {{ keypair: () => Promise<object>, signed: (o: object) => Promise<object> }} d  (seeded by the exporter)
 * @returns {Promise<{ agent: object, attacker: object, groups: { title: string, now?: number, steps: object[] }[] }>}
 */
export async function std2Groups({ keypair, signed }) {
  const agent = await keypair(), attacker = await keypair();
  const ok = (req, note, identifier = AGENT) => ({ req, expect: "verified", identifier, note });
  const bad = (req, classes, note) => ({ req, expect: "rejected", classes, note });
  const groups = [];
  const group = (title, steps, now) => groups.push({ title, steps, ...(now ? { now } : {}) });

  group("baseline — an honest signature is VERIFIED on the Pressure-2 route (the control for every case)", [
    ok(await signed({ key: agent }), "GET"),
    ok(await signed({ key: agent, method: "POST", body: '{"sku":1}' }), "POST with content-digest"),
    ok(await signed({ key: agent, agentHeader: `agent2="${AGENT}"`, agentKey: "agent2", label: "sig2" }), "dictionary key differs from the label (App. E.2.1 shape)"),
  ]);

  const flipped = await signed({ key: agent });
  const sig = fieldOf(flipped, "signature");
  const b = Buffer.from(sig.slice(sig.indexOf(":") + 1, -1), "base64"); b[5] ^= 0x01;
  group("tampered signature bytes → SPOOFED", [bad(withFields(flipped, { signature: `sig1=:${b.toString("base64")}:` }), ["SPOOFED"], "one flipped bit")]);

  const post = await signed({ key: agent, method: "POST", body: '{"sku":1}' });
  const get = await signed({ key: agent });
  const input = fieldOf(get, "signature-input");
  group("tampered covered components and parameters → SPOOFED", [
    bad(withFields(post, { "content-digest": `sha-256=:${Buffer.alloc(32).toString("base64")}:` }), ["SPOOFED"], "content-digest swapped"),
    bad({ ...post, method: "PUT" }, ["SPOOFED"], "@method changed"),
    bad(retarget(post, `${SITE}/checkout/2`), ["SPOOFED"], "@path changed"),
    bad(withFields(get, { "signature-input": input.replace(/expires=\d+/, `expires=${NOW_S + 30}`) }), ["SPOOFED"], "expires rewritten"),
    bad(withFields(get, { "signature-input": input.replace(/nonce="[^"]+"/, `nonce="${Buffer.alloc(64, 7).toString("base64")}"`) }), ["SPOOFED"], "nonce rewritten"),
    bad(withFields(get, { "signature-agent": `sig1="${ATTACKER}"` }), ["SPOOFED", "UNVERIFIED"], "Signature-Agent redirected to another directory"),
  ]);

  group("another key → never VERIFIED as the agent", [
    bad(await signed({ key: attacker, keyid: agent.kid }), ["SPOOFED"], "claims the agent's keyid"),
    bad(await signed({ key: attacker }), ["UNVERIFIED"], "keyid absent from the agent's directory"),
  ]);

  const here = await signed({ key: agent, url: `${SITE}/checkout/1` });
  group("another authority → SPOOFED", [
    bad(retarget(here, "https://other-shop.example/checkout/1"), ["SPOOFED"], "signed for shop.example, sent to other-shop.example"),
    bad(retarget(here, "https://shop.example:8443/checkout/1"), ["SPOOFED"], "same host, other port"),
    bad(await signed({ key: agent, components: [component("signature-agent", { key: "sig1" })] }), ["SPOOFED"], "@authority not covered"),
  ]);

  group("expired → SPOOFED (±30s skew is the only grace)", [
    bad(await signed({ key: agent, created: NOW_S - 100, expires: NOW_S - 40 }), ["SPOOFED"], "expired 40s ago"),
    bad(await signed({ key: agent, created: NOW_S - 91, expires: NOW_S - 31 }), ["SPOOFED"], "expired 31s ago"),
    ok(await signed({ key: agent, created: NOW_S - 89, expires: NOW_S - 29 }), "expired 29s ago is inside the skew"),
    bad(await signed({ key: agent, created: NOW_S - 3600, expires: NOW_S - 3540 }), ["SPOOFED"], "an hour old"),
  ]);

  group("future created → SPOOFED (±30s skew is the only grace)", [
    bad(await signed({ key: agent, created: NOW_S + 31 }), ["SPOOFED"], "created 31s ahead"),
    bad(await signed({ key: agent, created: NOW_S + 3600 }), ["SPOOFED"], "created an hour ahead"),
    ok(await signed({ key: agent, created: NOW_S + 29 }), "created 29s ahead is inside the skew"),
  ]);

  group("lifetime over 60s → SPOOFED", [
    bad(await signed({ key: agent, lifetime: 61 }), ["SPOOFED"], "61s"),
    bad(await signed({ key: agent, lifetime: 86_400 }), ["SPOOFED"], "one day"),
    ok(await signed({ key: agent, lifetime: 60 }), "60s is the limit"),
  ]);

  const plain = await signed({ key: agent });
  const plainInput = fieldOf(plain, "signature-input");
  group("missing expires / created / tag → SPOOFED", [
    bad(withFields(plain, { "signature-input": plainInput.replace(/;expires=\d+/, "") }), ["SPOOFED"], "expires removed"),
    bad(withFields(plain, { "signature-input": plainInput.replace(/;created=\d+/, "") }), ["SPOOFED"], "created removed"),
    bad(await signed({ key: agent, tag: null }), ["SPOOFED"], "signed without a tag"),
    bad(await signed({ key: agent, expires: null }), ["SPOOFED"], "signed without expires"),
  ]);

  group("wrong tag → SPOOFED (a validly signed, non-web-bot-auth signature is not a Web Bot Auth verification)", [
    bad(await signed({ key: agent, tag: "not-web-bot-auth" }), ["SPOOFED"], "tag not-web-bot-auth"),
    bad(await signed({ key: agent, tag: "Web-Bot-Auth" }), ["SPOOFED"], "tag differs only in case"),
  ]);

  const both = await signed({ key: agent, agentHeader: `sig1="${AGENT}", agent1="${AGENT}"`, agentKey: "sig1" });
  const renamed = await signed({ key: agent, agentHeader: `agent1="${AGENT}"`, agentKey: "agent1" });
  const s = await signed({ key: agent });
  group("Signature-Agent dictionary key vs the signature's covered member and label", [
    bad(withFields(both, { "signature-agent": `agent1="${AGENT}"` }), ["SPOOFED"], "covers key=sig1, dictionary has only agent1"),
    bad(withFields(renamed, { "signature-agent": `agent2="${AGENT}"` }), ["SPOOFED"], "member renamed after signing"),
    bad(await signed({ key: agent, components: ["@authority", "signature-agent"] }), ["SPOOFED"], "dictionary header, bare component"),
    bad(await signed({ key: agent, agentHeader: `sig1="${AGENT}", agent2="${ATTACKER}"`,
      components: ["@authority", component("signature-agent", { key: "sig1" }), component("signature-agent", { key: "agent2" })] }), ["SPOOFED"], "two members covered"),
    bad(withFields(s, { signature: fieldOf(s, "signature").replace(/^sig1=/, "sig2=") }), ["SPOOFED"], "Signature label sig2 vs Signature-Input label sig1"),
    ok(await signed({ key: attacker, agentHeader: `a="${AGENT}", b="${ATTACKER}"`, agentKey: "b", label: "sig1" }), "multi-member dictionary: attributed to the covered member", ATTACKER),
    bad(await signed({ key: attacker, agentHeader: `a="${AGENT}", b="${ATTACKER}"`, agentKey: "a", label: "sig1" }), ["UNVERIFIED"], "attacker key under the agent's member"),
  ]);

  group("Gate clock drives the checks (no wall-clock leak)", [
    bad(await signed({ key: agent }), ["SPOOFED"], "a signature valid at NOW is expired two minutes later"),
  ], NOW_MS + 120_000);

  return { agent, attacker, groups };
}

/** STD-2's test titles, read from the test file (GATE-10 requires a group for each). */
export function std2Titles(source) {
  return [...source.matchAll(/^test\("STD-2: (.+?)", /gm)].map((m) => m[1].replace(/\\"/g, '"'));
}
