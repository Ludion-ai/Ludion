// The Ludion Worker: serves the prerendered site and owns every dynamic route (docs/decisions.md).
// Serves static assets, /@<login>, and /mcp. Teaching happens on the teacher's machine (CLAUDE.md), not here.
import { createApp } from "./app.ts";

export default createApp();
