import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRIEFING_ERROR_TEXT, briefingLines, FALLBACK_LABEL, INITIAL_BRIEFING, reduceBriefing, runBriefing,
  type BriefingState,
} from "../lib/briefing-client.ts";
import type { MutationDeps } from "../lib/mutate-client.ts";

const sse = (...events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const META = { source: "model", cached: false, open_total: 5, listed: 3 };

function fold(...events: [string, unknown][]): BriefingState {
  const start: BriefingState = { ...INITIAL_BRIEFING, phase: "loading" };
  return events.reduce<BriefingState>((s, [event, data]) => reduceBriefing(s, { event, data }), start);
}

describe("reduceBriefing", () => {
  it("meta opens the stream, deltas append, done finishes", () => {
    const s = fold(["meta", META], ["delta", { text: "- a\n" }], ["delta", { text: "- b" }], ["done", { source: "model", cached: false, mails: 3 }]);
    assert.equal(s.phase, "done");
    assert.equal(s.text, "- a\n- b");
    assert.equal(s.source, "model");
    assert.equal(s.openTotal, 5);
  });

  it("shows the label for the fallback source", () => {
    const s = fold(["meta", { ...META, source: "fallback" }], ["delta", { text: "3 offene Mails." }], ["done", { source: "fallback", cached: false, mails: 3 }]);
    assert.equal(s.source, "fallback");
    assert.equal(FALLBACK_LABEL, "Zusammenfassung ohne KI");
  });

  it("error without fallback keeps the text and ends in the error state", () => {
    const s = fold(["meta", META], ["delta", { text: "- a" }], ["error", { code: "agent_failed", fallback: false }]);
    assert.equal(s.phase, "error");
    assert.equal(s.text, "- a");
    assert.deepEqual(s.error, { code: "agent_failed", fallback: false });
  });

  it("error with fallback swaps to the fallback text that follows", () => {
    const s = fold(["meta", META], ["delta", { text: "- partial" }], ["error", { code: "agent_failed", fallback: true }]);
    assert.equal(s.phase, "streaming", "delta and done still follow");
    assert.equal(s.source, "fallback");
    assert.equal(s.text, "");
    const end = reduceBriefing(reduceBriefing(s, { event: "delta", data: { text: "2 offene Mails." } }), { event: "done", data: { source: "fallback", cached: false, mails: 2 } });
    assert.equal(end.phase, "done");
    assert.equal(end.text, "2 offene Mails.");
    assert.equal(end.error, null);
  });

  it("ignores malformed events", () => {
    const s = fold(["delta", { text: 5 }], ["delta", null], ["unknown", {}]);
    assert.equal(s.text, "");
  });
});

describe("briefingLines", () => {
  it("splits on newlines, strips the bullet marker and drops empty lines", () => {
    assert.deepEqual(briefingLines("- Eins\n\n-  Zwei\r\nDrei\n"), [
      { text: "Eins", bullet: true }, { text: "Zwei", bullet: true }, { text: "Drei", bullet: false },
    ]);
  });
  it("leaves markup and links as plain text", () => {
    const [l] = briefingLines("- <script>x</script> [a](http://e.test) **fett**");
    assert.equal(l?.text, "<script>x</script> [a](http://e.test) **fett**");
  });
});

function deps(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const d: MutationDeps = {
    fetch: (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(queue.shift() ?? new Response("{}", { status: 500 }));
    },
    headers: (_p, token) => new Headers({ "x-csrf-token": "vf", "x-app-csrf": token }),
  };
  return { d, calls };
}
const session = () => new Response(JSON.stringify({ csrfToken: "t" }), { status: 200 });
const sseResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

describe("runBriefing", () => {
  it("posts /api/briefing with the CSRF handshake and feeds every event to onEvent", async () => {
    const f = deps([session(), sseResponse(sse(["meta", META], ["delta", { text: "- a" }], ["done", { source: "model", cached: true, mails: 3 }]))]);
    const names: string[] = [];
    const r = await runBriefing(f.d, (e) => names.push(e.event));
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(names, ["meta", "delta", "done"]);
    assert.equal(f.calls[1].url, "/api/briefing");
    assert.equal(f.calls[1].init?.method, "POST");
    assert.equal((f.calls[1].init?.headers as Headers).get("x-app-csrf"), "t");
  });

  it("maps JSON failures before the stream", async () => {
    for (const [status, reason] of [[401, "forbidden"], [403, "forbidden"], [429, "rate_limited"], [500, "failed"]] as const) {
      const f = deps([session(), new Response("{}", { status, headers: { "retry-after": "40" } })]);
      const r = await runBriefing(f.d, () => {});
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reason, reason);
    }
  });

  it("reports a broken stream as failed", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("net")); } });
    const f = deps([session(), new Response(body, { status: 200 })]);
    const r = await runBriefing(f.d, () => {});
    assert.deepEqual(r, { ok: false, reason: "failed" });
  });

  it("has a German text for every failure", () => {
    for (const k of ["rate_limited", "forbidden", "failed", "agent_failed", "briefing_failed", "stream_ended"] as const) {
      assert.ok(BRIEFING_ERROR_TEXT[k].length > 5, k);
    }
  });
});
