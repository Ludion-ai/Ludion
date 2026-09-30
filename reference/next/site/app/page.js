import { PRODUCTS } from "./products";

export default function Home() {
  return (
    <>
      <h1>Products</h1>
      <ul>
        {Object.entries(PRODUCTS).map(([id, [name, price]]) => (
          <li key={id}><a href={`/products/${id}`}>{name}</a> <span className="price">¥{price}</span></li>
        ))}
      </ul>
    </>
  );
}
