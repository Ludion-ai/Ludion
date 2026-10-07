// The Ludion Worker: serves the prerendered site and owns every dynamic route (worker.md).
// Serves static assets, /@<login>, /mcp, /api, and /auth. /api/feed arrives in step 7.
import { createApp } from "./app.ts";

export default createApp();
