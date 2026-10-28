// Offline stand-in for a Veryfront agent's stream() in the documented form (esm/src/agent/types.d.ts, AgentStreamInput /
// AgentStreamResult): callbacks onChunk / onFinish plus a result whose toDataStreamResponse() is an SSE body
// (`data: {json}\n\n`, text-delta frames {type, id, delta}, an {type:"error"} frame on failure).
import type { BriefingStreamArgs } from "../../lib/briefing.ts";

export interface FakeStreamOptions {
  chunks?: string[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** stream() itself rejects. */
  throwOnStream?: boolean;
  /** the body carries an error frame after the chunks. */
  errorFrame?: boolean;
  /** never finish; the body errors once the abort signal fires. */
  hang?: boolean;
}

export function fakeStreamAgent(o: FakeStreamOptions = {}) {
  const calls: BriefingStreamArgs[] = [];
  const chunks = o.chunks ?? ["- Eins", "\n- Zwei"];
  const frame = (v: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(v)}\n\n`);
  const agent = {
    async stream(args: BriefingStreamArgs) {
      calls.push(args);
      if (o.throwOnStream) throw new Error("provider said: secret detail");
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(frame({ type: "start" }));
          for (const text of chunks) {
            args.onChunk?.(text);
            controller.enqueue(frame({ type: "text-delta", id: "t1", delta: text }));
          }
          if (o.hang) {
            await new Promise<void>((resolve) => {
              if (args.abortSignal?.aborted) return resolve();
              args.abortSignal?.addEventListener("abort", () => resolve());
            });
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          if (o.errorFrame) {
            controller.enqueue(frame({ type: "error", error: "provider said: secret detail" }));
          } else {
            args.onFinish?.({ text: chunks.join(""), usage: o.usage ?? { promptTokens: 100, completionTokens: 20, totalTokens: 120 } });
          }
          controller.enqueue(frame({ type: "finish" }));
          controller.close();
        },
      });
      return { toDataStreamResponse: () => new Response(body, { headers: { "content-type": "text/event-stream" } }) };
    },
  };
  return { agent, calls };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function parseSse(text: string): SseEvent[] {
  return text.split("\n\n").filter((b) => b.trim().length > 0).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
    const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") as Record<string, unknown>;
    return { event, data };
  });
}
