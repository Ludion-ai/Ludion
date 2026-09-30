// @ludion/gate-next — the Ludion Gate as a Next.js 16 proxy. The whole install (ADR-022):
//
//   // proxy.js
//   export { proxy } from "@ludion/gate-next";
//
// plus ludion.config.json next to package.json. The receipt key comes from $LUDION_SITE_KEY.
import { NextResponse } from "next/server";
import { createNextGate } from "./core.mjs";

const gate = createNextGate({ next: () => NextResponse.next() });

export const proxy = gate.proxy;
export default proxy;
export { createNextGate };
