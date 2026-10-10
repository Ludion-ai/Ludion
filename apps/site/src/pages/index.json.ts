// dist/index.json: the active set, rebuilt with every deploy. See docs/decisions.md.
import { siteData } from "../build/data.ts";

export async function GET(): Promise<Response> {
  const { index } = await siteData();
  return new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
