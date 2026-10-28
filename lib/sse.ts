// Server-sent events over fetch (POST routes cannot use EventSource). A small incremental parser: it accepts packets
// cut at any byte, several events per packet, LF and CRLF, comments and multi-line data. Events whose data is not JSON
// are dropped. Text inside the JSON is never interpreted here.

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseParser {
  push(chunk: string): SseEvent[];
  /** The stream ended: emits a last event that lacks its closing blank line. */
  flush(): SseEvent[];
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) as unknown };
  } catch {
    return null;
  }
}

export function createSseParser(): SseParser {
  let buffer = "";
  const drain = (final: boolean): SseEvent[] => {
    // A lone "\r" at the very end may be the first half of "\r\n": keep it until more data arrives.
    let text = buffer;
    let tail = "";
    if (!final && text.endsWith("\r")) {
      tail = "\r";
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = text.split("\n\n");
    const rest = final ? "" : blocks.pop() ?? "";
    buffer = rest + tail;
    const out: SseEvent[] = [];
    for (const b of blocks) {
      const e = parseBlock(b);
      if (e) out.push(e);
    }
    return out;
  };
  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

/** Reads a response body to its end and yields the events; a read error propagates to the caller. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.flush();
  } finally {
    reader.releaseLock();
  }
}
