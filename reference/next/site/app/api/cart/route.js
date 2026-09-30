import { PRODUCTS } from "../../products";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body?.items) ? body.items : [];
  return Response.json({ items, total: items.reduce((s, i) => s + (PRODUCTS[i.id]?.[1] ?? 0) * (i.qty ?? 1), 0) }, { status: 201 });
}
