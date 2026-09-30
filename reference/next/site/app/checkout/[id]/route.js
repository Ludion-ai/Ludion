export async function GET(request, { params }) {
  const { id } = await params;
  return new Response(`<!doctype html><html lang="en"><head><title>Checkout · Reference Shop</title></head><body><h1>Checkout ${id}</h1></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function POST(request, { params }) {
  const { id } = await params;
  await request.formData();
  return new Response(null, { status: 303, headers: { location: `/orders/${id}` } });
}
