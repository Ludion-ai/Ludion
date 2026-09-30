// Reading logs: files, directories, stdin; gzip by magic bytes (not by extension); UTF-8 BOM;
// CRLF; a last line without a newline. Node only. Nothing here opens a socket.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 1 << 20;

/** Expand files and directories (recursively; hidden entries skipped) into a sorted file list. */
export function expandInputs(inputs) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p).sort()) if (!e.startsWith(".")) walk(path.join(p, e));
    } else if (st.isFile()) out.push(p);
  };
  for (const i of inputs) i === "-" ? out.push("-") : walk(i);
  return out;
}

async function isGzip(file) {
  if (file === "-") return false;
  const fd = await fs.promises.open(file, "r");
  try {
    const { bytesRead, buffer } = await fd.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally { await fd.close(); }
}

/**
 * Stream the lines of one input, in batches (one per read chunk). Empty lines are dropped;
 * `\r` before `\n` is dropped; a last line without a newline is kept.
 * @param {string} file path or "-" for stdin
 * @returns {Promise<{ gzip: boolean, batches: AsyncGenerator<string[]> }>}
 */
export async function openLines(file) {
  const gzip = await isGzip(file);
  const raw = file === "-" ? process.stdin : fs.createReadStream(file, { highWaterMark: CHUNK });
  const stream = gzip ? raw.pipe(zlib.createGunzip({ chunkSize: CHUNK })) : raw;
  async function* batches() {
    const dec = new StringDecoder("utf8");
    let rest = "", first = true;
    for await (const chunk of stream) {
      let s = rest + dec.write(chunk);
      if (first) { if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); first = false; }
      const out = [];
      let start = 0;
      for (let nl = s.indexOf("\n"); nl >= 0; nl = s.indexOf("\n", start)) {
        const end = nl > start && s.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        if (end > start) out.push(s.slice(start, end));
        start = nl + 1;
      }
      rest = s.slice(start);
      if (out.length) yield out;
    }
    rest += dec.end();
    if (rest.endsWith("\r")) rest = rest.slice(0, -1);
    if (rest) yield [rest];
  }
  return { gzip, batches: batches() };
}

/**
 * A file name that is safe to print: directories dropped, IP addresses masked (ALB and ELB put
 * the node's IP in the name), long digit runs (account IDs) masked.
 */
export function safeName(file) {
  if (file === "-") return "stdin";
  return path.basename(file)
    .replace(/(?<![0-9])\d{1,3}(?:[._-]\d{1,3}){3}(?![0-9])/g, "x.x.x.x")
    .replace(/(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/gi, "x:x::x")
    .replace(/\d{9,}/g, "#");
}
