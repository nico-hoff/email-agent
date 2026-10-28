import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dmarcText, fetchHitl, fetchRules, guessMatch, hitlTitle, postDeactivate, postDismiss, postRule, SENDER_ERROR_TEXT, splitCandidates,
  type HitlCandidate,
} from "../lib/senders-client.ts";
import type { MutationDeps } from "../lib/mutate-client.ts";

const cand = (over: Partial<HitlCandidate> = {}): HitlCandidate => ({
  key: "domain:spam.example", match: "domain", value: "spam.example", jev_spam_count: 4, mails_seen: 5, dmarc_pass_rate: 0.2, sample_email_ids: [1], ...over,
});
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

describe("texts and helpers", () => {
  it("hitlTitle names domain or address and the count", () => {
    assert.equal(hitlTitle(cand()), "Die Domain spam.example wurde 4× als Spam erkannt");
    assert.equal(hitlTitle(cand({ match: "address", value: "x@spam.example", jev_spam_count: 3 })), "Der Absender x@spam.example wurde 3× als Spam erkannt");
  });
  it("dmarcText is quiet and optional", () => {
    assert.equal(dmarcText(0.2), "DMARC bei 20 % der Mails bestanden");
    assert.equal(dmarcText(null), null);
  });
  it("splitCandidates shows two and keeps the rest", () => {
    const l = [cand({ key: "a" }), cand({ key: "b" }), cand({ key: "c" })];
    assert.deepEqual(splitCandidates(l).shown.map((c) => c.key), ["a", "b"]);
    assert.deepEqual(splitCandidates(l).rest.map((c) => c.key), ["c"]);
    assert.deepEqual(splitCandidates([]).shown, []);
  });
  it("guessMatch treats an @ as an address", () => {
    assert.equal(guessMatch(" a@b.example "), "address");
    assert.equal(guessMatch("b.example"), "domain");
  });
  it("explains the freemail refusal", () => {
    assert.match(SENDER_ERROR_TEXT.freemail_domain, /Freemail|Anbieter/);
  });
});

describe("fetches", () => {
  it("fetchHitl and fetchRules read the lists", async () => {
    assert.deepEqual(await fetchHitl(() => Promise.resolve(json({ candidates: [cand()] }))), [cand()]);
    const rule = { id: 1, kind: "blacklist", match: "domain", value: "x.example", account_id: null, source: "nico", active: 1, created_at: "2026-10-27T10:00:00.000Z" };
    let url = "";
    const rules = await fetchRules((u) => { url = String(u); return Promise.resolve(json({ rules: [rule] })); });
    assert.deepEqual(rules, [rule]);
    assert.equal(url, "/api/senders/rules");
  });
  it("a bad shape throws", async () => {
    await assert.rejects(fetchHitl(() => Promise.resolve(json({ nope: 1 }))));
  });
});

describe("posts", () => {
  it("postRule sends match, value and kind", async () => {
    const f = deps(json({ ok: true, rule: { id: 3 }, changed: true, deactivated_rule_ids: [] }));
    const r = await postRule({ match: "domain", value: "x.example", kind: "blacklist" }, f.d);
    assert.equal(r.ok, true);
    assert.equal(f.calls[1].url, "/api/senders/rules");
    assert.equal(f.calls[1].init?.body, JSON.stringify({ match: "domain", value: "x.example", kind: "blacklist" }));
  });
  it("postRule maps freemail_domain and invalid_value", async () => {
    const a = await postRule({ match: "domain", value: "gmail.com", kind: "blacklist" }, deps(json({ error: "freemail_domain" }, 400)).d);
    assert.equal(!a.ok && a.reason, "freemail_domain");
    const b = await postRule({ match: "address", value: "kaputt", kind: "allowlist" }, deps(json({ error: "invalid_value" }, 400)).d);
    assert.equal(!b.ok && b.reason, "invalid_value");
    const c = await postRule({ match: "address", value: "a@b.example", kind: "allowlist" }, deps(json({}, 429, { "retry-after": "9" })).d);
    assert.equal(!c.ok && c.reason, "rate_limited");
  });
  it("postDismiss and postDeactivate use their routes", async () => {
    const f = deps(json({ ok: true, changed: true }));
    assert.equal((await postDismiss({ match: "domain", value: "x.example" }, f.d)).ok, true);
    assert.equal(f.calls[1].url, "/api/senders/hitl/dismiss");
    assert.equal(f.calls[1].init?.body, JSON.stringify({ match: "domain", value: "x.example" }));
    const g = deps(json({ ok: true, rule: { id: 7 }, changed: true }));
    assert.equal((await postDeactivate(7, g.d)).ok, true);
    assert.equal(g.calls[1].url, "/api/senders/rules/7/deactivate");
    assert.equal(g.calls[1].init?.body, undefined);
  });
  it("a network failure is failed and nothing is repeated", async () => {
    const d: MutationDeps = { fetch: () => Promise.reject(new Error("x")), headers: () => new Headers() };
    assert.deepEqual(await postDismiss({ match: "domain", value: "x.example" }, d), { ok: false, reason: "failed" });
  });
});
