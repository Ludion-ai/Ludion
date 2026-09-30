// Reading logs in a browser: a File (or any Blob) in, the same line batches the CLI reads.
// gzip by magic bytes, as lines.mjs; DecompressionStream and TextDecoder stand in for zlib and
// StringDecoder. Web platform only, no node:*. Nothing here makes a request: the bytes come from
// the user's disk through the File API and stay in this JS realm.
import { batchLines, maskName, createScan } from "./core.mjs";

export { batchLines, maskName, createScan };
export { renderText } from "./render.mjs";

async function* chunksOf(stream) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally { reader.releaseLock(); }
}

function counted(stream, onBytes) {
  return onBytes ? stream.pipeThrough(new TransformStream({ transform(c, ctl) { onBytes(c.byteLength); ctl.enqueue(c); } })) : stream;
}

// ── gzip members ─────────────────────────────────────────────────────────────────────────────
// A .gz file may hold several members back to back (`cat a.gz b.gz`, some log shippers). zlib
// reads them all; DecompressionStream stops at the first and errors on the rest. So find where
// each member ends: a later offset that starts with a gzip header (1f 8b 08, reserved flags 0) is
// a member boundary exactly when the bytes before it, back to the previous boundary, inflate as
// one complete member (the CRC-32 and length in its trailer check out, nothing is left over).

/** Offsets > 0 that could start a gzip member. */
async function headerCandidates(blob) {
  const out = [];
  let base = 0, carry = new Uint8Array(0);
  for await (const chunk of chunksOf(blob.stream())) {
    let buf = chunk;
    if (carry.length) { buf = new Uint8Array(carry.length + chunk.length); buf.set(carry); buf.set(chunk, carry.length); }
    const lim = buf.length - 3;
    for (let i = buf.indexOf(0x1f); i >= 0 && i < lim; i = buf.indexOf(0x1f, i + 1)) {
      if (buf[i + 1] === 0x8b && buf[i + 2] === 8 && (buf[i + 3] & 0xe0) === 0 && base + i > 0) out.push(base + i);
    }
    const keep = Math.min(3, buf.length);
    carry = buf.slice(buf.length - keep);
    base += buf.length - keep;
  }
  return out;
}

async function inflatesWhole(blob) {
  const reader = blob.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  try { while (!(await reader.read()).done); return true; } catch { return false; }
}

/** [start, end) of every member, in order. */
async function gzipMembers(blob) {
  const members = [];
  let start = 0;
  for (const c of await headerCandidates(blob)) {
    if (await inflatesWhole(blob.slice(start, c))) { members.push([start, c]); start = c; }
  }
  members.push([start, blob.size]);
  return members;
}

async function* inflateMembers(blob, members, onBytes) {
  for (const [a, b] of members) yield* chunksOf(counted(blob.slice(a, b).stream(), onBytes).pipeThrough(new DecompressionStream("gzip")));
}

/** UTF-8 across chunk (and member) boundaries; the BOM is kept so batchLines drops exactly one, as the CLI does. */
async function* decodeText(byteChunks) {
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  for await (const c of byteChunks) { const s = dec.decode(c, { stream: true }); if (s) yield s; }
  const tail = dec.decode();
  if (tail) yield tail;
}

/**
 * Stream the lines of one Blob, in batches; see batchLines.
 * @param {Blob} blob
 * @param {{ onBytes?: (n: number) => void }} [opts] onBytes is called with each raw chunk's size
 * @returns {Promise<{ gzip: boolean, batches: AsyncGenerator<string[]> }>}
 */
export async function openBlobLines(blob, { onBytes } = {}) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzip = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
  const bytes = gzip ? inflateMembers(blob, await gzipMembers(blob), onBytes) : chunksOf(counted(blob.stream(), onBytes));
  return { gzip, batches: batchLines(decodeText(bytes)) };
}

/** Browsers hand out the base name; sort like the CLI sorts a directory. */
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Scan dropped files, in name order, into the same report object `ludion scan --json` prints.
 * @param {Blob[]|File[]} files
 * @param {{ format?: string, top?: number, onBytes?: (n: number) => void }} [opts]
 */
export async function scanFiles(files, { onBytes, ...opts } = {}) {
  const s = createScan(opts);
  for (const f of [...files].sort(byName)) await s.add(maskName(f.name ?? "blob"), await openBlobLines(f, { onBytes }));
  return s.finish();
}
