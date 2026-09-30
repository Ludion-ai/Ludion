import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function Account() {
  if (!(await cookies()).has("session")) redirect("/login");
  return (
    <>
      <h1>Your orders</h1>
      <p>No orders yet.</p>
    </>
  );
}
