// @ludion/diver — free identity for agents. Three minutes to register, one line to sign.
export { generateEd25519, diverIdFromRoot, directoryDocument, cardDocument, base32, DIRECTORY_MEDIA_TYPE, HTTP_MESSAGE_SIGNATURES_DIRECTORY,
  sealRootKey, openRootKey, isSealedRoot, MIN_PASSPHRASE_LENGTH } from "./keys.mjs";
export { createDiverSigner, ludionFetch, DEFAULT_LIFETIME_S } from "./sign.mjs";
