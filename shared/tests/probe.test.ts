import { describe, expect, it } from "vitest";
import { classifyEnv, classifyOsClass } from "../src/probe";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1",
  ipadDesktopMasquerade:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8a Build/AD1A.240530.047; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36",
  lineIab:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8a Build/AD1A.240530.047; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Line/14.10.1/IAB",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
};

describe("classifyEnv (B-6 IAB token list)", () => {
  it("plain browsers are env browser", () => {
    for (const ua of [UA.iphoneSafari, UA.androidChrome, UA.windowsChrome, UA.macChrome]) {
      expect(classifyEnv(ua)).toBe("browser");
    }
  });

  it("detects every IAB token", () => {
    const tokens = [
      UA.androidWebView, // "; wv)"
      UA.lineIab, // "Line/"
      `${UA.androidChrome} FB_IAB/FB4A`,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) [FBAN/FBIOS;FBAV/420.0]",
      `${UA.androidChrome} Instagram 300.0.0.0`,
      `${UA.androidChrome} MicroMessenger/8.0.50`,
      `${UA.iphoneSafari} GSA/300.0.0`,
    ];
    for (const ua of tokens) expect(classifyEnv(ua)).toBe("webview-iab");
  });
});

describe("classifyOsClass", () => {
  it("iPhone Safari → ios-webkit", () => {
    expect(classifyOsClass({ ua: UA.iphoneSafari, platform: "iPhone", maxTouchPoints: 5 })).toBe(
      "ios-webkit",
    );
  });

  it("A-3: iPadOS masquerading as desktop Safari → ios-webkit", () => {
    expect(
      classifyOsClass({ ua: UA.ipadDesktopMasquerade, platform: "MacIntel", maxTouchPoints: 5 }),
    ).toBe("ios-webkit");
  });

  it("real Mac (no touch points) → desktop", () => {
    expect(
      classifyOsClass({ ua: UA.ipadDesktopMasquerade, platform: "MacIntel", maxTouchPoints: 0 }),
    ).toBe("desktop");
  });

  it("Android Chrome → android-chromium", () => {
    expect(
      classifyOsClass({ ua: UA.androidChrome, platform: "Linux armv8l", maxTouchPoints: 5 }),
    ).toBe("android-chromium");
  });

  it("Windows / Mac / Linux desktop → desktop", () => {
    for (const ua of [UA.windowsChrome, UA.macChrome, UA.linuxFirefox]) {
      expect(classifyOsClass({ ua, platform: "x", maxTouchPoints: 0 })).toBe("desktop");
    }
  });

  it("unknown UA → other", () => {
    expect(classifyOsClass({ ua: "weird-bot/1.0", platform: "", maxTouchPoints: 0 })).toBe("other");
  });
});
