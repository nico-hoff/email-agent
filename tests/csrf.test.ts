import { test } from "node:test";
import assert from "node:assert/strict";
import { CSRF_HEADER, CSRF_TTL_MS, issueCsrfToken, verifyCsrf } from "../lib/csrf.ts";

const SECRET = Buffer.alloc(32, 7);
const ORIGIN = "https://mac.tailnet-example.ts.net";
const NOW = 1_800_000_000_000;
const ME = "nico@example.test";

function req(headers: Record<string, string>, method = "POST") {
  return new Request("http://127.0.0.1:3000/api/emails/1/feedback", { method, headers });
}
const opts = (over: Partial<Parameters<typeof verifyCsrf>[1]> = {}) =>
  ({ identity: ME, secret: SECRET, allowedOrigins: [ORIGIN], now: () => NOW, ...over });

test("same-origin POST with a fresh token for the same identity passes", () => {
  const token = issueCsrfToken(ME, SECRET, NOW - 1000);
  assert.deepEqual(verifyCsrf(req({ origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: token }), opts()), { ok: true });
});

test("missing or foreign Origin is rejected", () => {
  const token = issueCsrfToken(ME, SECRET, NOW);
  assert.deepEqual(verifyCsrf(req({ [CSRF_HEADER]: token }), opts()), { ok: false, code: "origin_missing" });
  assert.deepEqual(verifyCsrf(req({ origin: "https://evil.example", [CSRF_HEADER]: token }), opts()), { ok: false, code: "origin_mismatch" });
  assert.deepEqual(verifyCsrf(req({ origin: "null", [CSRF_HEADER]: token }), opts()), { ok: false, code: "origin_mismatch" });
});

test("a cross-site fetch metadata header is rejected even with a valid Origin", () => {
  const token = issueCsrfToken(ME, SECRET, NOW);
  assert.deepEqual(verifyCsrf(req({ origin: ORIGIN, "sec-fetch-site": "cross-site", [CSRF_HEADER]: token }), opts()),
    { ok: false, code: "cross_site" });
});

test("token problems: missing, tampered, other identity, expired, from the future", () => {
  const h = (t?: string) => req({ origin: ORIGIN, ...(t === undefined ? {} : { [CSRF_HEADER]: t }) });
  const token = issueCsrfToken(ME, SECRET, NOW);
  assert.deepEqual(verifyCsrf(h(), opts()), { ok: false, code: "token_missing" });
  assert.deepEqual(verifyCsrf(h(token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA")), opts()), { ok: false, code: "token_invalid" });
  assert.deepEqual(verifyCsrf(h("garbage"), opts()), { ok: false, code: "token_invalid" });
  assert.deepEqual(verifyCsrf(h(issueCsrfToken("other@example.test", SECRET, NOW)), opts()), { ok: false, code: "token_invalid" });
  assert.deepEqual(verifyCsrf(h(issueCsrfToken(ME, Buffer.alloc(32, 8), NOW)), opts()), { ok: false, code: "token_invalid" });
  assert.deepEqual(verifyCsrf(h(issueCsrfToken(ME, SECRET, NOW - CSRF_TTL_MS - 1)), opts()), { ok: false, code: "token_expired" });
  assert.deepEqual(verifyCsrf(h(issueCsrfToken(ME, SECRET, NOW + 60_000)), opts()), { ok: false, code: "token_invalid" });
});

test("only POST is accepted as a state-changing request", () => {
  const token = issueCsrfToken(ME, SECRET, NOW);
  assert.deepEqual(verifyCsrf(req({ origin: ORIGIN, [CSRF_HEADER]: token }, "PUT"), opts()), { ok: false, code: "method_not_allowed" });
});

test("a short secret is refused", () => {
  assert.throws(() => issueCsrfToken(ME, Buffer.alloc(8), NOW), /secret/);
});
