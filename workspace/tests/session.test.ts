import { describe, expect, it } from "vitest";
import { parseCookies, serializeCookie, signSession, verifySession, type Session } from "../src/session";

const SECRET = "secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = 1_900_000_000_000;

function makeSession(exp: number): Session {
  return { uid: "7", login: "octocat", iat: NOW, exp };
}

describe("session signing", () => {
  it("round-trips a valid, unexpired session", async () => {
    const token = await signSession(makeSession(NOW + 1000), SECRET);
    const out = await verifySession(token, SECRET, NOW);
    expect(out).toEqual(makeSession(NOW + 1000));
  });

  it("rejects an expired session", async () => {
    const token = await signSession(makeSession(NOW - 1), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(makeSession(NOW + 1000), SECRET);
    expect(await verifySession(token, "other-secret", NOW)).toBeNull();
  });

  it("rejects a tampered body", async () => {
    const token = await signSession(makeSession(NOW + 1000), SECRET);
    const [, sig] = token.split(".");
    const forged = `${btoa('{"uid":"999","login":"x","iat":0,"exp":9999999999999}')}.${sig}`;
    expect(await verifySession(forged, SECRET, NOW)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifySession("garbage", SECRET, NOW)).toBeNull();
    expect(await verifySession("", SECRET, NOW)).toBeNull();
  });
});

describe("cookies", () => {
  it("serializes an httpOnly, SameSite=Lax cookie", () => {
    const c = serializeCookie("k", "v", { maxAgeSeconds: 60 });
    expect(c).toContain("k=v");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(c).toContain("Max-Age=60");
  });

  it("parses a cookie header into a map", () => {
    expect(parseCookies("a=1; b=two; c=")).toEqual({ a: "1", b: "two", c: "" });
    expect(parseCookies(null)).toEqual({});
  });
});
