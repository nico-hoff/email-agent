import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyToClipboard, DRAFT_ERROR_TEXT, draftErrorText, postDraft, reasonText, showDraftButton } from "../lib/draft-client.ts";
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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("postDraft", () => {
  it("posts without a body and returns the draft", async () => {
    const f = deps(json({ draft: "Hallo", language: "de", tone: "neutral", needs_human_check: true, reasons: ["unsicher"] }));
    const r = await postDraft(9, f.d);
    assert.deepEqual(r, { ok: true, draft: "Hallo", language: "de", tone: "neutral", needsHumanCheck: true, reasons: ["unsicher"] });
    assert.equal(f.calls[1].url, "/api/emails/9/draft");
    assert.equal(f.calls[1].init?.body, undefined);
  });

  it("maps the error codes", async () => {
    const cases: [number, unknown, string][] = [
      [409, { error: "not_eligible", reasons: ["security_auth"] }, "not_eligible"],
      [409, { error: "not_available_in_synthetic" }, "not_available_in_synthetic"],
      [409, { error: "not_classified" }, "not_classified"],
      [409, { error: "source_gone" }, "source_gone"],
      [502, { error: "fetch_failed" }, "fetch_failed"],
      [502, { error: "agent_failed" }, "agent_failed"],
      [502, { error: "invalid_output" }, "invalid_output"],
      [503, { error: "agent_unavailable" }, "agent_unavailable"],
      [404, { error: "email_not_found" }, "not_found"],
      [429, {}, "rate_limited"],
      [401, {}, "forbidden"],
      [500, {}, "failed"],
    ];
    for (const [status, body, code] of cases) {
      const r = await postDraft(1, deps(json(body, status, { "retry-after": "20" })).d);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.code, code, `${status}`);
    }
  });

  it("keeps the reasons of not_eligible", async () => {
    const r = await postDraft(1, deps(json({ error: "not_eligible", reasons: ["security_auth", "addresses_an_ai"] }, 409)).d);
    assert.deepEqual(!r.ok && r.reasons, ["security_auth", "addresses_an_ai"]);
  });

  it("treats a malformed 200 as failed", async () => {
    const r = await postDraft(1, deps(json({ draft: 5 })).d);
    assert.equal(!r.ok && r.code, "failed");
  });
});

describe("texts", () => {
  it("synthetic mode reads Im Testmodus nicht verfügbar", () => {
    assert.equal(DRAFT_ERROR_TEXT.not_available_in_synthetic, "Im Testmodus nicht verfügbar");
  });
  it("not_eligible names the reasons in plain language", () => {
    const t = draftErrorText({ code: "not_eligible", reasons: ["security_auth", "addresses_an_ai"] });
    assert.match(t, /Sicherheit|Anmelde/);
    assert.match(t, /KI/);
    assert.ok(!t.includes("security_auth") && !t.includes("addresses_an_ai"));
  });
  it("an unknown reason code never leaks as a raw code", () => {
    assert.ok(!reasonText("weird_code_x").includes("weird_code_x"));
  });
  it("every code has a text", () => {
    for (const t of Object.values(DRAFT_ERROR_TEXT)) assert.ok(t.length > 5);
  });
});

describe("showDraftButton", () => {
  const base = { open: false, needs_my_reply: null, route: null } as const;
  it("is offered for open mails, positive reply need and route draft_reply only", () => {
    assert.equal(showDraftButton({ ...base, open: true }), true);
    assert.equal(showDraftButton({ ...base, needs_my_reply: "positive" }), true);
    assert.equal(showDraftButton({ ...base, route: "draft_reply" }), true);
    assert.equal(showDraftButton({ ...base }), false);
    assert.equal(showDraftButton({ ...base, needs_my_reply: "negative", route: "ignore" }), false);
  });
});

describe("copyToClipboard", () => {
  it("uses the Clipboard API", async () => {
    let got = "";
    assert.equal(await copyToClipboard("Text", { clipboard: { writeText: (t) => { got = t; return Promise.resolve(); } } }), true);
    assert.equal(got, "Text");
  });
  it("falls back when the API rejects or is missing", async () => {
    let legacy = "";
    const fb = (t: string) => { legacy = t; return true; };
    assert.equal(await copyToClipboard("A", { clipboard: { writeText: () => Promise.reject(new Error("denied")) }, legacy: fb }), true);
    assert.equal(legacy, "A");
    assert.equal(await copyToClipboard("B", { legacy: fb }), true);
    assert.equal(legacy, "B");
  });
  it("reports false when nothing works", async () => {
    assert.equal(await copyToClipboard("C", {}), false);
    assert.equal(await copyToClipboard("C", { legacy: () => { throw new Error("x"); } }), false);
  });
});
