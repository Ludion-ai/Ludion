import { notFound } from "next/navigation";
import { PRODUCTS } from "../../products";

export default async function Product({ params }) {
  const { id } = await params;
  const p = PRODUCTS[id];
  if (!p) notFound();
  return (
    <>
      <h1>{p[0]}</h1>
      <p className="price">¥{p[1]}</p>
      <form method="post" action={`/checkout/${id}`}><button>Buy</button></form>
    </>
  );
}
