export const dynamic = "force-dynamic";

export function GET() {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const part of ["first\n", "second\n", "third\n"]) {
        controller.enqueue(enc.encode(part));
        await new Promise((r) => setTimeout(r, 250));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
