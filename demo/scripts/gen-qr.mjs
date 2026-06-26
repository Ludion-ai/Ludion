// Gate 2.5 F-4: build-time QR of the demo URL (no external QR service).
// The canonical deploy URL — confirm before deploying; changing it is a
// one-constant edit + rebuild. Output is gitignored (generated artifact).
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import QRCode from "qrcode";

// The standalone /demo playground was removed (commit 8812dfc); the QR now
// points at the on-page instrumented demo on the public landing (anchor id
// "capability"). Canonical production origin matches PLAYGROUND_ORIGIN in
// src/dashboard/setup.ts ("https://ludion.ai").
const DEMO_URL = "https://ludion.ai/#capability";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(outDir, { recursive: true });

const svg = await QRCode.toString(DEMO_URL, {
  type: "svg",
  errorCorrectionLevel: "M",
  margin: 1,
  color: { dark: "#0A0A0A", light: "#FFFFFF" }, // Gate 2.6: ink on white (mono identity)
});
writeFileSync(join(outDir, "qr.svg"), svg);
console.log(`gen-qr: ${DEMO_URL} -> public/qr.svg`);
