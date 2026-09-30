// RFC 7638 JWK Thumbprint (SHA-256, base64url) for OKP/EC/RSA keys — the keyid of Web Bot Auth.
import { createHash } from "node:crypto";
import { jwkThumbprintPreCompute } from "jsonwebkey-thumbprint";
export function thumbprint(jwk) {
  return createHash("sha256").update(jwkThumbprintPreCompute(jwk)).digest("base64url");
}
