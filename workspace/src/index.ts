import { handleRequest, type WorkspaceEnv } from "./handler";

/**
 * Standalone Worker entry — for `wrangler dev` local verification. In production
 * the same `handleRequest` runs behind same-origin Pages Functions (see
 * demo/functions/*), which is what keeps the session cookie same-origin.
 */
export default {
  async fetch(request: Request, env: WorkspaceEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
