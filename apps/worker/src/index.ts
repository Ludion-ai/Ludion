// The Ludion Worker: serves the prerendered site and owns every dynamic route (worker.md).
// Serves static assets and /@<login> so far; /mcp arrives in step 5, /api and /auth in step 6.
import { createApp } from "./app.ts";

export default createApp();
