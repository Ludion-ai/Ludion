import { describe, expect, it } from "vitest";
import { sseDataEvents } from "../src/server";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of sseDataEvents(body)) out.push(ev);
  return out;
}

describe("sseDataEvents (Q3: incremental, no whole-response buffering)", () => {
  it("parses simple data events", async () => {
    const events = await collect(streamOf('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'));
    expect(events).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("handles events split across arbitrary chunk boundaries", async () => {
    const events = await collect(
      streamOf('data: {"hel', 'lo":"wor', 'ld"}\n', "\nda", 'ta: {"x":', "1}\n\n"),
    );
    expect(events).toEqual(['{"hello":"world"}', '{"x":1}']);
  });

  it("handles CRLF line endings", async () => {
    const events = await collect(streamOf('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n'));
    expect(events).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("joins multi-line data fields and ignores comments/other fields", async () => {
    const events = await collect(
      streamOf(': keep-alive\nevent: message\nid: 7\ndata: line1\ndata: line2\n\n'),
    );
    expect(events).toEqual(["line1\nline2"]);
  });

  it("yields a trailing event without final blank line", async () => {
    const events = await collect(streamOf('data: {"a":1}\n\ndata: tail\n'));
    expect(events).toEqual(['{"a":1}', "tail"]);
  });

  it("handles multibyte UTF-8 split across chunks", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"t":"日本語"}\n\n');
    const mid = 12; // splits inside a multibyte sequence
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, mid));
        c.enqueue(bytes.slice(mid));
        c.close();
      },
    });
    expect(await collect(body)).toEqual(['{"t":"日本語"}']);
  });
});
