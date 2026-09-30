// Session key rotation (spec §10.3, §8.1: accountability is fixed, exposure rotates).
//
// Two steps, so no verifier ever meets a key it has not seen, and none needs to refetch on a miss:
//   1. publish   the next key goes into the directory next to the current one; signing continues
//                with the current key.
//   2. activate  once every cache has had time to refresh (the overlap, at least the directory's
//                max-age), signing moves to the next key and the old one leaves the directory.
//                Its private key leaves the store; a verifier stops accepting it when its cached
//                directory expires.
// The identifier (Signature-Agent origin, the card and its client_id, diver_id) and the Root never
// change, and the Root is never needed: rotation does not open it.

import { generateEd25519, directoryDocument } from "./keys.mjs";

/** The Card Host serves directories with max-age=300: an overlap of 300s outlives every cached copy. */
export const DEFAULT_OVERLAP_S = 300;

export class RotationPendingError extends Error {
  constructor(activeAt) {
    super(`the next session key becomes active at ${new Date(activeAt).toISOString()}`);
    this.name = "RotationPendingError"; this.activeAt = activeAt;
  }
}

const publicOf = (jwk) => ({ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: jwk.kid });

/**
 * One rotation step on a store (ludion.json v0). Pure: returns the new store and the directory to
 * publish; the caller writes them (directory first when publishing, store first when activating).
 * @param {object} store
 * @param {{ now?: number, overlapS?: number, force?: boolean }} [o]
 * @returns {Promise<{ step: "published"|"activated", store: object, directory: { keys: object[] }, activeAt?: number }>}
 */
export async function rotateSession(store, { now = Date.now(), overlapS = DEFAULT_OVERLAP_S, force = false } = {}) {
  if (!store?.session?.d) throw new Error("the store has no session key");
  if (!Number.isFinite(overlapS) || overlapS < 0) throw new Error("overlap must be a non-negative number of seconds");
  if (!store.next) {
    const next = await generateEd25519();
    const activeAt = now + overlapS * 1000;
    return {
      step: "published", activeAt,
      store: { ...store, next: { ...next.privateJwk, published: new Date(now).toISOString(), active_at: new Date(activeAt).toISOString() } },
      directory: directoryDocument([publicOf(store.session), next.publicJwk]),
    };
  }
  const activeAt = Date.parse(store.next.active_at);
  if (!(now >= activeAt) && !force) throw new RotationPendingError(activeAt);
  const { published: _p, active_at: _a, ...session } = store.next;
  const { next: _n, ...rest } = store;
  return {
    step: "activated",
    store: { ...rest, session, rotated: new Date(now).toISOString() },
    directory: directoryDocument([publicOf(session)]),
  };
}
