// Reference shop on Express 5: what a small site looks like before it installs the Gate.
// Deterministic on purpose (no random session IDs), so GATE-1 can compare bytes.
import { createHash } from "node:crypto";
import express from "express";

const app = express();
app.use(express.static("public"));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Reference Shop</title><link rel="stylesheet" href="/style.css"></head>
<body><header><img src="/logo.png" alt="" width="16" height="16"> <a href="/">Reference Shop</a></header>
<main>${body}</main></body></html>`;
const session = (user) => createHash("sha256").update(`reference:${user}`).digest("base64url").slice(0, 22);
const PRODUCTS = { 1: ["Lamp", 4900], 2: ["Kettle", 3200], 3: ["Chair", 12900] };

app.get("/", (req, res) => {
  res.cookie("theme", req.cookies?.theme ?? "light", { path: "/", sameSite: "lax" });
  res.type("html").send(page("Home", `<h1>Products</h1><ul>${Object.entries(PRODUCTS)
    .map(([id, [name, price]]) => `<li><a href="/products/${id}">${name}</a> <span class="price">¥${price}</span></li>`).join("")}</ul>`));
});
app.get("/products/:id", (req, res) => {
  const p = PRODUCTS[req.params.id];
  if (!p) return res.status(404).type("html").send(page("Not found", "<h1>No such product</h1>"));
  res.type("html").send(page(p[0], `<h1>${p[0]}</h1><p class="price">¥${p[1]}</p><form method="post" action="/checkout/${req.params.id}"><button>Buy</button></form>`));
});
app.get("/search", (req, res) => {
  const q = String(req.query.q ?? "").toLowerCase();
  res.json({ q, results: Object.entries(PRODUCTS).filter(([, [n]]) => n.toLowerCase().includes(q)).map(([id, [name]]) => ({ id, name })) });
});
app.get("/login", (req, res) => res.type("html").send(page("Log in", `<form method="post" action="/login"><input name="user"><input name="password" type="password"><button>Log in</button></form>`)));
app.post("/login", (req, res) => {
  if (!req.body?.user || !req.body?.password) return res.status(400).type("html").send(page("Log in", "<p>Missing credentials</p>"));
  res.cookie("session", session(req.body.user), { httpOnly: true, sameSite: "lax", path: "/" });
  res.redirect(302, "/account");
});
app.get("/account", (req, res) => {
  const cookie = req.get("cookie") ?? "";
  if (!/(^|;\s*)session=/.test(cookie)) return res.redirect(302, "/login");
  res.set("Cache-Control", "private, no-store").type("html").send(page("Account", "<h1>Your orders</h1><p>No orders yet.</p>"));
});
app.post("/api/cart", (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  res.status(201).json({ items, total: items.reduce((s, i) => s + (PRODUCTS[i.id]?.[1] ?? 0) * (i.qty ?? 1), 0) });
});
app.get("/checkout/:id", (req, res) => res.type("html").send(page("Checkout", `<h1>Checkout ${req.params.id}</h1>`)));
app.post("/checkout/:id", (req, res) => res.redirect(303, `/orders/${req.params.id}`));
app.get("/old-home", (req, res) => res.redirect(301, "/"));
app.get("/stream", async (req, res) => {
  res.type("text/plain");
  for (const part of ["first\n", "second\n", "third\n"]) {
    res.write(part);
    await new Promise((r) => setTimeout(r, 250));
  }
  res.end();
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`reference shop on http://127.0.0.1:${port}`));
