// Test support for the Registry: throwaway Registry keys and Diver identities, and a fetch that
// routes a Diver's calls into an in-process Registry. Nothing here is a production key.
import { generateEd25519, diverIdFromRoot } from "@ludion/diver";
import { generateRegistryKey } from "@ludion/gate-core/staple";
import { createRegistry, createMemoryStore } from "../src/index.mjs";

export const REGISTRY_ORIGIN = "https://registry.test";

/** A Diver's ludion.json-shaped store, with the Root kept open (tests only). */
export async function diverStore(name = "Test agent") {
  const root = await generateEd25519();
  const session = await generateEd25519();
  const diverId = diverIdFromRoot(root.publicJwk);
  return {
    store: { v: 0, diver_id: diverId, signature_agent: `https://${diverId}.agents.ludion.test`, name, contacts: ["mailto:ops@example.test"], session: session.privateJwk },
    root: root.privateJwk,
    session: session.privateJwk,
  };
}

/** An in-process Registry and a fetch that reaches it. */
export async function registryWorld({ now, ...rest } = {}) {
  const key = await generateRegistryKey();
  const store = createMemoryStore();
  const registry = await createRegistry({ key: key.privateJwk, origin: REGISTRY_ORIGIN, store, now, ...rest });
  const seen = [];
  const fetch = async (url, init = {}) => {
    const req = new Request(url, init);
    seen.push({ url: req.url, method: req.method, headers: [...req.headers], body: init.body == null ? null : String(init.body) });
    return registry.fetch(req);
  };
  return { registry, key, store, fetch, seen };
}
