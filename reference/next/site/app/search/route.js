import { PRODUCTS } from "../products";

export function GET(request) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
  const results = Object.entries(PRODUCTS).filter(([, [n]]) => n.toLowerCase().includes(q)).map(([id, [name]]) => ({ id, name }));
  return Response.json({ q, results });
}
