import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyFeedback, CATEGORY_CHOICES, EMPTY_FEEDBACK, fetchFeedback, FEEDBACK_ERROR_TEXT, postFeedback, type FeedbackState,
} from "../lib/feedback-client.ts";
import type { MutationDeps } from "../lib/mutate-client.ts";

function deps(res: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [new Response(JSON.stringify({ csrfToken: "t" })), res];
  const d: MutationDeps = {
    fetch: (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve(queue.shift() ?? new Response("{}", { status: 500 })); },
    headers: (_p, token) => new Headers({ "x-app-csrf": token }),
  };
  return { d, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("applyFeedback", () => {
  it("sets the topic of the kind and leaves the others", () => {
    const s: FeedbackState = { spam: null, reply: "reply_needed", category: null };
    assert.deepEqual(applyFeedback(s, "spam_correct"), { spam: "spam_correct", reply: "reply_needed", category: null });
    assert.deepEqual(applyFeedback(s, "not_spam"), { spam: "not_spam", reply: "reply_needed", category: null });
    assert.deepEqual(applyFeedback(s, "no_reply_needed"), { spam: null, reply: "no_reply_needed", category: null });
    assert.deepEqual(applyFeedback(s, "category_wrong", "personal"), { spam: null, reply: "reply_needed", category: "personal" });
  });
  it("does not mutate its input", () => {
    const s = { ...EMPTY_FEEDBACK };
    applyFeedback(s, "not_spam");
    assert.deepEqual(s, EMPTY_FEEDBACK);
  });
  it("offers the seven categories", () => {
    assert.deepEqual([...CATEGORY_CHOICES].sort(), ["business", "newsletter_promo", "personal", "security_auth", "spam", "transactional", "unclear"]);
  });
});

describe("fetchFeedback", () => {
  it("reads the current state", async () => {
    const f: typeof fetch = () => Promise.resolve(json({ id: 3, feedback: { spam: "not_spam", reply: null, category: "business" } }));
    assert.deepEqual(await fetchFeedback(3, f), { spam: "not_spam", reply: null, category: "business" });
  });
  it("returns null for a 404 and throws for other failures", async () => {
    assert.equal(await fetchFeedback(3, () => Promise.resolve(json({}, 404))), null);
    await assert.rejects(fetchFeedback(3, () => Promise.resolve(json({}, 500))));
  });
});

describe("postFeedback", () => {
  it("posts kind (and value for category_wrong) as JSON", async () => {
    const f = deps(json({ ok: true, feedback: { spam: null, reply: null, category: "personal" } }));
    const r = await postFeedback(4, "category_wrong", "personal", f.d);
    assert.deepEqual(r, { ok: true, feedback: { spam: null, reply: null, category: "personal" } });
    assert.equal(f.calls[1].url, "/api/emails/4/feedback");
    assert.equal(f.calls[1].init?.method, "POST");
    assert.equal(f.calls[1].init?.body, JSON.stringify({ kind: "category_wrong", value: "personal" }));
    assert.equal((f.calls[1].init?.headers as Headers).get("content-type"), "application/json");
  });
  it("omits value for the other kinds", async () => {
    const f = deps(json({ ok: true, feedback: EMPTY_FEEDBACK }));
    await postFeedback(4, "not_spam", undefined, f.d);
    assert.equal(f.calls[1].init?.body, JSON.stringify({ kind: "not_spam" }));
  });
  it("maps failures", async () => {
    for (const [status, reason] of [[429, "rate_limited"], [403, "forbidden"], [404, "not_found"], [400, "failed"], [500, "failed"]] as const) {
      const r = await postFeedback(4, "not_spam", undefined, deps(json({}, status)).d);
      assert.equal(!r.ok && r.reason, reason);
    }
    for (const t of Object.values(FEEDBACK_ERROR_TEXT)) assert.ok(t.length > 5);
  });
});
