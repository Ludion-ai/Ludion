// The Ludion Worker: serves the prerendered site and owns every dynamic route (worker.md).
// Serves static assets, /@<login>, and /mcp (step 5); /api and /auth arrive in step 6.
import { createApp } from "./app.ts";

export default createApp();
