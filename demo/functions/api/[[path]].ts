// Pages Function: same-origin /api/* (config read/write). Thin adapter — all
// logic and the §1 storage-invariant enforcement live in ludion-workspace.
import { handleRequest, type WorkspaceEnv } from "ludion-workspace/handler";

export const onRequest: PagesFunction<WorkspaceEnv> = (ctx) => handleRequest(ctx.request, ctx.env);
