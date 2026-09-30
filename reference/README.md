# Reference apps

Three small shops that serve the same routes: Express 5, Next.js 16, and Cloudflare Workers. GATE-1 and GATE-3 (`accept/registry.mjs`) run them for real.

- **`<app>/site/`**: the shop before it installs the Gate. It has its own `package-lock.json` and is not a root workspace, because Next.js and workerd would slow every `npm ci`.
- **`<app>/install/`**: exactly what installing the Gate adds or changes. GATE-3 measures it with `git diff --no-index`: at most 3 lines of app code and 1 config file.
- **`harness.mjs`**: builds two real installs in the OS temp dir, cached by content hash:
  - `site/` + `npm ci`
  - `site/` + `install/` + `npm ci` + `npm install` of the packed `@ludion/*` tarballs, as a customer would
  
  It also starts the servers, and has a raw HTTP/1.1 client that keeps the bytes on the wire.
- **`requests.mjs`**: unsigned browser traffic, in the header sets and orders of Chrome, Safari and Firefox.
- **`test/gate1.test.mjs`**: humans untouched, compared byte for byte. Every masked part is listed in `NORMALISATIONS`, with the reason.
- **`test/gate3.test.mjs`**: install size, and the time to the first classified event.

Run one:

```sh
node --test --test-name-pattern "^GATE-1:" reference/test/gate1.test.mjs
```

To try an app by hand, run `npm ci` in `<app>/site`, then copy `<app>/install` over it and `npm install` the adapter.
