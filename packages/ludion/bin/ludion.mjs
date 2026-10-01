#!/usr/bin/env node
// `npx ludion`: the unscoped name for the CLI in @ludion/diver. In the published tarball the CLI's
// code is vendored under lib/ (build.mjs, at prepack), so this package installs alone (PUB-3); in
// the repository it comes from the workspace.
import { existsSync } from "node:fs";

const vendored = new URL("../lib/@ludion/diver/bin/ludion.mjs", import.meta.url);
await import(existsSync(vendored) ? vendored.href : "@ludion/diver/cli");
