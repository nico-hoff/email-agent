import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postEmailDone, type MutationDeps } from "../lib/mutate-client.ts";

interface Call { url: string; init?: RequestInit }

function deps(responses: Response[]): { deps: MutationDeps; calls: Call[]; headerCalls: [string, string][] } {
  const calls: Call[] = [];
  const headerCalls: [string, string][] = [];
  const queue = [...responses];
  return {
    calls,
    headerCalls,
    deps: {
      fetch: (url, init) => {
        calls.push({ url: String(url), init });
        const r = queue.shift();
        return Promise.resolve(r ?? new Response("{}", { status: 500 }));
      },
      headers: (path, token) => {
        headerCalls.push([path, token]);
        return new Headers({ "x-csrf-token": "vf", "x-app-csrf": token });
      },
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("postEmailDone", () => {
  it("fetches a fresh app token, then posts /done with the double-submit headers and no body", async () => {
    const f = deps([json({ login: "nico", csrfToken: "tok-1", signedIn: true }), json({ ok: true, id: 7, done: true, seen: false })]);
    const r = await postEmailDone(7, true, f.deps);
    assert.deepEqual(r, { ok: true, done: true, seen: false });
    assert.equal(f.calls[0].url, "/api/auth/session");
    assert.equal(f.calls[1].url, "/api/emails/7/done");
    assert.equal(f.calls[1].init?.method, "POST");
    assert.equal(f.calls[1].init?.body, undefined, "no body: no mail data and no content to forge");
    assert.deepEqual(f.headerCalls, [["/api/emails/7/done", "tok-1"]]);
    assert.equal(new Headers(f.calls[1].init?.headers).get("x-app-csrf"), "tok-1");
  });

  it("uses /undone for undo", async () => {
    const f = deps([json({ csrfToken: "t" }), json({ ok: true, id: 7, done: false, seen: true })]);
    const r = await postEmailDone(7, false, f.deps);
    assert.deepEqual(r, { ok: true, done: false, seen: true });
    assert.equal(f.calls[1].url, "/api/emails/7/undone");
  });

  it("reports the rate limit with its wait time", async () => {
    const f = deps([json({ csrfToken: "t" }), json({ error: "rate_limited" }, 429, { "retry-after": "12" })]);
    assert.deepEqual(await postEmailDone(1, true, f.deps), { ok: false, reason: "rate_limited", retryAfterSeconds: 12 });
  });

  it("maps other failures to fixed reasons and never repeats the write", async () => {
    const forbidden = deps([json({ csrfToken: "t" }), json({ error: "token_expired" }, 403)]);
    assert.deepEqual(await postEmailDone(1, true, forbidden.deps), { ok: false, reason: "forbidden" });
    const missing = deps([json({ csrfToken: "t" }), json({ error: "not_found" }, 404)]);
    assert.deepEqual(await postEmailDone(1, true, missing.deps), { ok: false, reason: "not_found" });
    const broken = deps([json({ csrfToken: "t" }), json({ error: "x" }, 500)]);
    assert.deepEqual(await postEmailDone(1, true, broken.deps), { ok: false, reason: "failed" });
    assert.equal(broken.calls.filter((c) => c.init?.method === "POST").length, 1);
  });

  it("fails without a write when the session call fails or fetch throws", async () => {
    const noSession = deps([json({ error: "unauthorized" }, 401)]);
    assert.deepEqual(await postEmailDone(1, true, noSession.deps), { ok: false, reason: "forbidden" });
    assert.equal(noSession.calls.length, 1);
    const throwing: MutationDeps = { fetch: () => Promise.reject(new Error("offline")), headers: () => new Headers() };
    assert.deepEqual(await postEmailDone(1, true, throwing), { ok: false, reason: "failed" });
  });
});
