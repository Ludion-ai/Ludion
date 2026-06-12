// Gate 2.5 F-4: build-time QR of the demo URL (no external QR service).
// The canonical deploy URL — confirm before deploying; changing it is a
// one-constant edit + rebuild. Output is gitignored (generated artifact).
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import QRCode from "qrcode";

const DEMO_URL = "https://ludion-demo.pages.dev/";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(outDir, { recursive: true });

const svg = await QRCode.toString(DEMO_URL, {
  type: "svg",
  errorCorrectionLevel: "M",
  margin: 1,
  color: { dark: "#F3F6FA", light: "#0D1A2E" }, // PAPER on DEEP (identity)
});
writeFileSync(join(outDir, "qr.svg"), svg);
console.log(`gen-qr: ${DEMO_URL} -> public/qr.svg`);
