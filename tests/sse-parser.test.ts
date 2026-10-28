import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSseParser, readSseEvents } from "../lib/sse.ts";

const enc = new TextEncoder();
const stream = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      c.close();
    },
  });

async function collect(chunks: string[]) {
  const out = [];
  for await (const e of readSseEvents(stream(chunks))) out.push(e);
  return out;
}

describe("SSE parser", () => {
  it("parses several events in one chunk", () => {
    const p = createSseParser();
    const ev = p.push('event: meta\ndata: {"source":"model"}\n\nevent: delta\ndata: {"text":"- a"}\n\n');
    assert.deepEqual(ev, [
      { event: "meta", data: { source: "model" } },
      { event: "delta", data: { text: "- a" } },
    ]);
  });

  it("waits for the blank line when an event arrives in partial packets", () => {
    const p = createSseParser();
    assert.deepEqual(p.push("event: del"), []);
    assert.deepEqual(p.push('ta\ndata: {"te'), []);
    assert.deepEqual(p.push('xt":"x"}\n'), []);
    assert.deepEqual(p.push("\n"), [{ event: "delta", data: { text: "x" } }]);
  });

  it("handles CRLF, comments and a CRLF split across chunks", () => {
    const p = createSseParser();
    assert.deepEqual(p.push(': ping\r\nevent: done\r\ndata: {"mails":2}\r'), []);
    assert.deepEqual(p.push("\n\r\n"), [{ event: "done", data: { mails: 2 } }]);
  });

  it("joins multi-line data and skips events whose data is not JSON", () => {
    const p = createSseParser();
    const ev = p.push('event: delta\ndata: {"text":\ndata: "a"}\n\nevent: delta\ndata: not json\n\nevent: done\ndata: {}\n\n');
    assert.deepEqual(ev, [{ event: "delta", data: { text: "a" } }, { event: "done", data: {} }]);
  });

  it("defaults the event name to message and keeps text inside JSON untouched", () => {
    const p = createSseParser();
    const ev = p.push('data: {"text":"<script>alert(1)</script> [x](http://e.test)"}\n\n');
    assert.deepEqual(ev, [{ event: "message", data: { text: "<script>alert(1)</script> [x](http://e.test)" } }]);
  });

  it("flush emits a last event that lacks the closing blank line", () => {
    const p = createSseParser();
    p.push('event: done\ndata: {"mails":1}\n');
    assert.deepEqual(p.flush(), [{ event: "done", data: { mails: 1 } }]);
    assert.deepEqual(p.flush(), []);
  });
});

describe("readSseEvents", () => {
  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = enc.encode('event: delta\ndata: {"text":"Prüfen"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "ü"
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out = [];
    for await (const e of readSseEvents(body)) out.push(e);
    assert.deepEqual(out, [{ event: "delta", data: { text: "Prüfen" } }]);
  });

  it("yields events across chunks and flushes at the end", async () => {
    const out = await collect(['event: meta\ndata: {"source":"fallback"}\n\nevent: de', 'lta\ndata: {"text":"a"}\n\nevent: done\ndata: {"mails":0}\n']);
    assert.deepEqual(out.map((e) => e.event), ["meta", "delta", "done"]);
  });
});
