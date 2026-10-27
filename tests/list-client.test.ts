import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendUnique, fetchDetail, fetchPage, SessionExpired } from "../lib/list-client.ts";
import type { ApiEmail } from "../lib/review-ui.ts";

const reply = (body: unknown, status = 200): typeof fetch => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;
const row = (id: number) => ({ id }) as ApiEmail;

describe("list client", () => {
  it("returns the page body and asks without caching", async () => {
    let init: RequestInit | undefined;
    const fetcher = ((_u: string, i?: RequestInit) => {
      init = i;
      return Promise.resolve(new Response(JSON.stringify({ emails: [], next_cursor: null, counts: {}, accounts: [], view: "important" })));
    }) as typeof fetch;
    const page = await fetchPage("/api/emails?view=important", fetcher);
    assert.deepEqual(page.emails, []);
    assert.equal(init?.cache, "no-store");
  });

  it("signals an expired session on 401 and 403, other errors as unavailable", async () => {
    await assert.rejects(fetchPage("/x", reply({ error: "unauthorized" }, 401)), SessionExpired);
    await assert.rejects(fetchPage("/x", reply({ error: "origin_mismatch" }, 403)), SessionExpired);
    await assert.rejects(fetchPage("/x", reply({ error: "emails_unavailable" }, 500)), /unavailable/);
    await assert.rejects(fetchPage("/x", reply({ nope: 1 })), /unavailable/);
  });

  it("returns null for an unknown mail and the body otherwise", async () => {
    assert.equal(await fetchDetail(5, reply({ error: "not_found" }, 404)), null);
    assert.deepEqual(await fetchDetail(5, reply({ id: 5 })), { id: 5 });
  });

  it("appends without duplicates", () => {
    assert.deepEqual(appendUnique([row(1), row(2)], [row(2), row(3)]).map((m) => m.id), [1, 2, 3]);
  });
});
