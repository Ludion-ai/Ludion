// The Ludion Worker: serves the prerendered site and owns every dynamic route (worker.md).
// Step 3 serves static assets and /@<login>; /mcp, /api, and /auth arrive in steps 4 and 5.
import { createApp } from "./app.ts";

export default createApp();
