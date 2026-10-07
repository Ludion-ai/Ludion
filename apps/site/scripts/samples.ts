// Build or preview the design samples with LUDION_SAMPLES=1 on Windows and Linux alike.
//   npm run build:samples -w @ludion/site     → apps/site/dist-samples
//   npm run preview:samples -w @ludion/site   → serves it on http://127.0.0.1:4321
import { spawnSync } from "node:child_process";

const command = process.argv[2] === "preview" ? ["preview", "--host", "127.0.0.1", "--port", "4321"] : ["build"];
const result = spawnSync("npx", ["astro", ...command], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, LUDION_SAMPLES: "1" },
});
process.exit(result.status ?? 1);
