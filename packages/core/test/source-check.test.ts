import { describe, expect, it } from "vitest";
import { checkSource, normalizeText } from "../src/index.ts";
import { fakeFetch } from "./helpers.ts";

const page = (html: string, init: ResponseInit = {}) => () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });
const redirect = (to: string) => () => new Response(null, { status: 301, headers: { location: to } });

describe("normalizeText", () => {
  it("strips script, style, comments, and tags", () => {
    expect(normalizeText("<style>p{}</style><p>Hello</p><script>alert(1)</script><!-- x --><p>World</p>")).toBe("hello world");
  });

  it("decodes entities, applies NFKC, lowercases, collapses whitespace", () => {
    expect(normalizeText("Caf&eacute;?&nbsp;&amp;&#65;&#x42;  ＦＵＬＬ\n\twidth")).toBe("café? &ab full width");
  });

  it("knows the whole Latin-1 entity table", () => {
    expect(normalizeText("&iexcl;&Agrave;&times;&szlig;&yuml;")).toBe("¡à×ßÿ");
    expect(normalizeText("&unknown; stays")).toBe("&unknown; stays");
  });

  it("straightens quotes and dashes", () => {
    expect(normalizeText("“It’s” — fine – ok")).toBe(`"it's" - fine - ok`);
    expect(normalizeText("&ldquo;It&rsquo;s&rdquo; &mdash; fine")).toBe(`"it's" - fine`);
  });
});

describe("checkSource", () => {
  const url = "https://docs.example.com/page";

  it("finds a quote split across tags", async () => {
    const f = fakeFetch({ [url]: page("<p>Python 3.12 <em>removed</em> the <a href='#'>dist</a><b>utils</b> module.</p>") });
    expect(await checkSource(url, "Python 3.12 removed the distutils module.", f)).toEqual({ found: true });
  });

  it("finds a quote across block elements and curly quotes", async () => {
    const f = fakeFetch({ [url]: page("<li>It’s gone.</li><li>Use setuptools.</li>") });
    expect(await checkSource(url, "It's gone. Use setuptools.", f)).toEqual({ found: true });
  });

  it("reports a missing quote with the host", async () => {
    const f = fakeFetch({ [url]: page("<p>Something else.</p>") });
    expect(await checkSource(url, "Not on the page", f)).toEqual({
      found: false,
      reason: "That quote isn't on docs.example.com. Copy a sentence exactly as it appears on the page.",
    });
  });

  it("ignores text inside scripts", async () => {
    const f = fakeFetch({ [url]: page("<script>var s = 'secret quote here';</script>") });
    expect((await checkSource(url, "secret quote here", f)).found).toBe(false);
  });

  it("sends the Ludion user agent and does not follow redirects blindly", async () => {
    const f = fakeFetch({ [url]: page("<p>ok text</p>") });
    await checkSource(url, "ok text", f);
    const init = f.calls[0]!.init!;
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("LudionBot/0.1 (+https://ludion.ai/bot)");
  });

  it("refuses http", async () => {
    const f = fakeFetch({});
    expect(await checkSource("http://example.com/", "anything", f)).toEqual({ found: false, reason: expect.stringContaining("not https") });
    expect(f.calls).toHaveLength(0);
  });

  it("follows up to 3 redirects, resolving relative locations", async () => {
    const f = fakeFetch({
      [url]: redirect("/a"),
      "https://docs.example.com/a": redirect("https://other.example.com/b"),
      "https://other.example.com/b": redirect("/c"),
      "https://other.example.com/c": page("<p>final text</p>"),
    });
    expect(await checkSource(url, "final text", f)).toEqual({ found: true });
  });

  it("gives up after 3 redirects", async () => {
    const f = fakeFetch({
      [url]: redirect("/1"),
      "https://docs.example.com/1": redirect("/2"),
      "https://docs.example.com/2": redirect("/3"),
      "https://docs.example.com/3": redirect("/4"),
    });
    expect(await checkSource(url, "x".repeat(8), f)).toEqual({ found: false, reason: expect.stringContaining("more than 3 times") });
  });

  it("refuses a redirect to http", async () => {
    const f = fakeFetch({ [url]: redirect("http://docs.example.com/plain") });
    expect(await checkSource(url, "anything", f)).toEqual({ found: false, reason: expect.stringContaining("not https") });
    expect(f.calls).toHaveLength(1);
  });

  it("refuses a redirect to a private address", async () => {
    const f = fakeFetch({ [url]: redirect("https://169.254.169.254/latest/meta-data/") });
    expect(await checkSource(url, "anything", f)).toEqual({ found: false, reason: expect.stringContaining("will not fetch") });
    expect(f.calls.map((c) => c.url)).toEqual([url]);
  });

  it("refuses a redirect to a private name", async () => {
    const f = fakeFetch({ [url]: redirect("https://metadata.google.internal/") });
    expect((await checkSource(url, "anything", f)).found).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it.each(["application/pdf", "image/png", "application/json", ""])("refuses content type %j", async (type) => {
    const headers: Record<string, string> = type ? { "content-type": type } : {};
    // A byte body, so Response adds no default content type.
    const f = fakeFetch({ [url]: () => new Response(new TextEncoder().encode("quote text here"), { headers }) });
    const r = await checkSource(url, "quote text here", f);
    expect(r).toEqual({ found: false, reason: expect.stringContaining("is not a web page") });
  });

  it.each(["text/plain; charset=utf-8", "application/xhtml+xml", "TEXT/HTML"])("reads content type %j", async (type) => {
    const f = fakeFetch({ [url]: () => new Response("quote text here", { headers: { "content-type": type } }) });
    expect(await checkSource(url, "quote text here", f)).toEqual({ found: true });
  });

  it("reports HTTP errors", async () => {
    const f = fakeFetch({ [url]: page("gone", { status: 404 }) });
    expect(await checkSource(url, "anything", f)).toEqual({ found: false, reason: expect.stringContaining("HTTP 404") });
  });

  it("reports an unreachable host", async () => {
    expect(await checkSource(url, "anything", fakeFetch({}))).toEqual({ found: false, reason: "Could not reach docs.example.com. Check the URL." });
  });

  it("reads at most 2 MB", async () => {
    const big = "<p>" + "a ".repeat(1024 * 1024) + "</p><p>tail quote</p>";
    const f = fakeFetch({ [url]: page(big) });
    expect((await checkSource(url, "tail quote", f)).found).toBe(false);
    const f2 = fakeFetch({ [url]: page("<p>head quote</p>" + "a ".repeat(1024 * 1024)) });
    expect((await checkSource(url, "head quote", f2)).found).toBe(true);
  });

  it("times out after 5 seconds", async () => {
    const hang = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const started = Date.now();
    const r = await checkSource(url, "anything", hang);
    expect(r).toEqual({ found: false, reason: expect.stringContaining("within 5 seconds") });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
  }, 10_000);
});
