import { handleRelay, type RelayEnv } from "./relay";

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelay(request, env);
  },
};
