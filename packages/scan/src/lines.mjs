// Reading logs: files, directories, stdin; gzip by magic bytes (not by extension); UTF-8 BOM;
// CRLF; a last line without a newline. Node only (the browser's twin is web.mjs); the line
// splitting itself is shared (core.mjs). Nothing here opens a socket.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { batchLines, maskName } from "./core.mjs";

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

async function* decode(stream) {
  const dec = new StringDecoder("utf8");
  for await (const chunk of stream) yield dec.write(chunk);
  const tail = dec.end();
  if (tail) yield tail;
}

/**
 * Stream the lines of one input, in batches (one per read chunk); see batchLines.
 * @param {string} file path or "-" for stdin
 * @returns {Promise<{ gzip: boolean, batches: AsyncGenerator<string[]> }>}
 */
export async function openLines(file) {
  const gzip = await isGzip(file);
  const raw = file === "-" ? process.stdin : fs.createReadStream(file, { highWaterMark: CHUNK });
  const stream = gzip ? raw.pipe(zlib.createGunzip({ chunkSize: CHUNK })) : raw;
  return { gzip, batches: batchLines(decode(stream)) };
}

/** A file name that is safe to print: directories dropped, then maskName. */
export function safeName(file) {
  if (file === "-") return "stdin";
  return maskName(path.basename(file));
}
