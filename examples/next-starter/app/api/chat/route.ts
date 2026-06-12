// The relay proxy (docs/recipes/nextjs-route-handler.md): the browser talks
// to this same-origin route, this route talks to your provider, and the API
// key never leaves the server.
export async function POST(req: Request): Promise<Response> {
  const upstream = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: await req.text(), // forwarded unchanged; SSE streams back as-is
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    },
  });
}
