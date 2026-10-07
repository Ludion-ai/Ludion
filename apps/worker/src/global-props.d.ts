// Declares the main module so `exports` from "cloudflare:workers" (ctx.exports) is typed.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
  }
}
