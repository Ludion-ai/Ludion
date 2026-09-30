export const metadata = { title: "Reference Shop" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head><link rel="stylesheet" href="/style.css" /></head>
      <body>
        <header><img src="/logo.png" alt="" width="16" height="16" /> <a href="/">Reference Shop</a></header>
        <main>{children}</main>
      </body>
    </html>
  );
}
