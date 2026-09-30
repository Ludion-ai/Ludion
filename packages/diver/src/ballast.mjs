// Ballast v0 (spec §14): the commitments an operator makes when registering a Diver. Nothing moves
// but the promise; the Registry measures it and a broken one lowers Depth or revokes.
export const BALLAST_V0 = ["abuse_response_24h", "revocation_consent", "glass_consent"];
