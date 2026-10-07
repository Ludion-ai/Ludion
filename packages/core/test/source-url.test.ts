import { describe, expect, it } from "vitest";
import { checkSource, sourceUrlProblem } from "../src/index.ts";
import { fakeFetch } from "./helpers.ts";

/** checkSource must refuse `url` before any request goes out. */
async function refusedBeforeFetch(url: string, reason: RegExp): Promise<void> {
  const f = fakeFetch({});
  const r = await checkSource(url, "any quote at all", f);
  expect(r).toEqual({ found: false, reason: expect.stringMatching(reason) });
  expect(f.calls).toHaveLength(0);
}

const IP = /IP address/;
const NAME = /not a public domain name/;

describe("sourceUrlProblem refuses, before any request", () => {
  it("a private IPv4 address", () => refusedBeforeFetch("https://10.0.0.1/", IP));
  it("a loopback IPv4 address", () => refusedBeforeFetch("https://127.0.0.1/", IP));
  it("a link-local IPv4 address", () => refusedBeforeFetch("https://169.254.1.1/", IP));
  it("0.0.0.0", () => refusedBeforeFetch("https://0.0.0.0/", IP));
  it("a CGNAT IPv4 address", () => refusedBeforeFetch("https://100.64.0.1/", IP));
  it("the cloud metadata address 169.254.169.254", () => refusedBeforeFetch("https://169.254.169.254/latest/meta-data/", IP));
  it("a public IPv4 address too: no IP hosts at all", () => refusedBeforeFetch("https://8.8.8.8/", IP));

  it("loopback written in decimal", () => refusedBeforeFetch("https://2130706433/", IP));
  it("loopback written in hex", () => refusedBeforeFetch("https://0x7f000001/", IP));
  it("loopback written in octal", () => refusedBeforeFetch("https://0177.0.0.1/", IP));
  it("loopback written short with a trailing dot", () => refusedBeforeFetch("https://127.1./", IP));

  it("[::1]", () => refusedBeforeFetch("https://[::1]/", IP));
  it("[fc00::1]", () => refusedBeforeFetch("https://[fc00::1]/", IP));
  it("[fe80::1]", () => refusedBeforeFetch("https://[fe80::1]/", IP));
  it("[::ffff:127.0.0.1]", () => refusedBeforeFetch("https://[::ffff:127.0.0.1]/", IP));

  it("localhost", () => refusedBeforeFetch("https://localhost/", NAME));
  it("localhost. with a trailing dot", () => refusedBeforeFetch("https://localhost./", NAME));
  it("a.localhost", () => refusedBeforeFetch("https://a.localhost/", NAME));
  it("a single-label name", () => refusedBeforeFetch("https://intranet/", NAME));
  it("a .internal name", () => refusedBeforeFetch("https://metadata.google.internal/", NAME));
  it.each(["printer.local", "router.home.arpa", "site.test", "x.invalid", "www.example", "abc.onion", "home.arpa", "LOCALHOST", "Metadata.Google.Internal."])(
    "the reserved name %s",
    (host) => refusedBeforeFetch(`https://${host}/`, NAME),
  );

  it("a port other than 443", () => refusedBeforeFetch("https://docs.example.com:8443/", /port 8443/));
  it("a URL with a user name", () => refusedBeforeFetch("https://user@docs.example.com/", /user name or password/));
  it("a URL with a user name and password", () => refusedBeforeFetch("https://user:pw@docs.example.com/", /user name or password/));
  it("http", () => refusedBeforeFetch("http://docs.example.com/", /not https/));
});

describe("sourceUrlProblem allows", () => {
  it.each(["https://peps.python.org/pep-0632/", "https://docs.example.com:443/a", "https://example.com./", "https://xn--bcher-kva.example.org/"])("%s", (url) => {
    expect(sourceUrlProblem(new URL(url))).toBeUndefined();
  });
});
