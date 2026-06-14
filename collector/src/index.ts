import { handleRequest, type CollectorEnv, type ExecutionContextLike } from "./handler";
import { rebuildAggregate } from "./aggregate";

export default {
  async fetch(
    request: Request,
    env: CollectorEnv,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  // Optional freshness floor (decisions OQ1): if the operator wires a Cron
  // trigger in wrangler.toml, this refreshes the aggregate during no-submit
  // periods. The feature works fully without it via the amortized submit path.
  async scheduled(_event: unknown, env: CollectorEnv, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(rebuildAggregate(env).catch(() => undefined));
  },
};
