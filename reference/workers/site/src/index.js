// Reference shop on Cloudflare Workers, in the shape `npm create cloudflare` starts from.
// Deterministic on purpose (no random session IDs), so GATE-1 can compare bytes.
const PRODUCTS = { 1: ["Lamp", 4900], 2: ["Kettle", 3200], 3: ["Chair", 12900] };
const CSS = "body { font-family: system-ui, sans-serif; margin: 2rem; color: #1b1f24; }\na { color: #0f766e; }\n.price { font-variant-numeric: tabular-nums; }\n";
const LOGO = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPgL8sjCTGMahjVMHw1AADRzfMB5Ye3vAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const page = (title, body, init = {}) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Reference Shop</title><link rel="stylesheet" href="/style.css"></head>
<body><header><img src="/logo.png" alt="" width="16" height="16"> <a href="/">Reference Shop</a></header>
<main>${body}</main></body></html>`, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });

async function session(user) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`reference:${user}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const { pathname } = url, method = request.method;
		let m;
		if (pathname === "/" && (method === "GET" || method === "HEAD")) {
			return page("Home", `<h1>Products</h1><ul>${Object.entries(PRODUCTS).map(([id, [name, price]]) => `<li><a href="/products/${id}">${name}</a> <span class="price">¥${price}</span></li>`).join("")}</ul>`,
				{ headers: { "set-cookie": "theme=light; Path=/; SameSite=Lax" } });
		}
		if (pathname === "/style.css") return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" } });
		if (pathname === "/logo.png") return new Response(LOGO, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });
		if ((m = pathname.match(/^\/products\/([^/]+)$/))) {
			const p = PRODUCTS[m[1]];
			if (!p) return page("Not found", "<h1>No such product</h1>", { status: 404 });
			return page(p[0], `<h1>${p[0]}</h1><p class="price">¥${p[1]}</p><form method="post" action="/checkout/${m[1]}"><button>Buy</button></form>`);
		}
		if (pathname === "/search") {
			const q = (url.searchParams.get("q") ?? "").toLowerCase();
			return Response.json({ q, results: Object.entries(PRODUCTS).filter(([, [n]]) => n.toLowerCase().includes(q)).map(([id, [name]]) => ({ id, name })) });
		}
		if (pathname === "/login" && method === "GET") return page("Log in", `<form method="post" action="/login"><input name="user"><input name="password" type="password"><button>Log in</button></form>`);
		if (pathname === "/login" && method === "POST") {
			const form = await request.formData();
			if (!form.get("user") || !form.get("password")) return page("Log in", "<p>Missing credentials</p>", { status: 400 });
			return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": `session=${await session(form.get("user"))}; Path=/; HttpOnly; SameSite=Lax` } });
		}
		if (pathname === "/account") {
			if (!/(^|;\s*)session=/.test(request.headers.get("cookie") ?? "")) return new Response(null, { status: 302, headers: { location: "/login" } });
			return page("Account", "<h1>Your orders</h1><p>No orders yet.</p>", { headers: { "cache-control": "private, no-store" } });
		}
		if (pathname === "/api/cart" && method === "POST") {
			const body = await request.json().catch(() => ({}));
			const items = Array.isArray(body?.items) ? body.items : [];
			return Response.json({ items, total: items.reduce((s, i) => s + (PRODUCTS[i.id]?.[1] ?? 0) * (i.qty ?? 1), 0) }, { status: 201 });
		}
		if ((m = pathname.match(/^\/checkout\/([^/]+)$/))) {
			if (method === "POST") { await request.formData(); return new Response(null, { status: 303, headers: { location: `/orders/${m[1]}` } }); }
			return page("Checkout", `<h1>Checkout ${m[1]}</h1>`);
		}
		if (pathname === "/old-home") return Response.redirect(`${url.origin}/`, 301);
		if (pathname === "/stream") {
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter(), enc = new TextEncoder();
			ctx.waitUntil((async () => {
				for (const part of ["first\n", "second\n", "third\n"]) {
					await writer.write(enc.encode(part));
					await new Promise((r) => setTimeout(r, 250));
				}
				await writer.close();
			})());
			return new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		return page("Not found", "<h1>Not found</h1>", { status: 404 });
	},
};
