// Pages Function: same-origin /auth/* (login, callback, logout). Thin adapter —
// all logic lives in the tested ludion-workspace package. Same-origin is what
// lets the session cookie be httpOnly + SameSite=Lax with no CORS.
import { handleRequest, type WorkspaceEnv } from "ludion-workspace/handler";

export const onRequest: PagesFunction<WorkspaceEnv> = (ctx) => handleRequest(ctx.request, ctx.env);
