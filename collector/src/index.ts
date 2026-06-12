import { handleRequest, type CollectorEnv } from "./handler";

export default {
  async fetch(request: Request, env: CollectorEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
