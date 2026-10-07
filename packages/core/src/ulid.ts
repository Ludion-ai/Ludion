const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

/** A ULID: 10 chars of millisecond time, then 16 chars of randomness (Crockford base32). */
export function newId(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`Cannot make an id for time ${now}. Use a millisecond timestamp between 0 and ${MAX_TIME}.`);
  }
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const b of bytes) random += CROCKFORD[b % 32];
  return time + random;
}
