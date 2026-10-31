import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dummyHash, hashPassword, MAX_USER_PASSWORD_CHARS, MIN_USER_PASSWORD_CHARS, passwordProblem, verifyPassword } from "../lib/user-password.ts";

const PW = "synthetic-test-password-1";
// Cheap parameters keep the tests fast; the format and bounds are what is under test.
const FAST = { N: 1024, r: 8, p: 1 };

describe("user passwords", () => {
  it("hash has the self-describing format, a fresh salt each time, and never contains the password", async () => {
    const a = await hashPassword(PW, FAST);
    const b = await hashPassword(PW, FAST);
    assert.match(a, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
    assert.ok(!a.includes(PW));
    assert.match(await hashPassword(PW), /^scrypt\$32768\$8\$1\$/);
  });

  it("verifies the right password and refuses a wrong, empty or oversized one", async () => {
    const h = await hashPassword(PW, FAST);
    assert.equal(await verifyPassword(h, PW), true);
    assert.equal(await verifyPassword(h, PW + "x"), false);
    assert.equal(await verifyPassword(h, ""), false);
    assert.equal(await verifyPassword(h, "x".repeat(MAX_USER_PASSWORD_CHARS + 1)), false);
    assert.equal(await verifyPassword(h, 42 as unknown as string), false);
  });

  it("a malformed or out-of-bounds stored hash is simply false (no throw, no huge memory request)", async () => {
    const good = await hashPassword(PW, FAST);
    const parts = good.split("$");
    for (const bad of [
      "", "plain", "scrypt$1$8$1$aaaa$bbbb",
      `scrypt$${2 ** 24}$8$1$${parts[4]}$${parts[5]}`, // N far above the bound
      `scrypt$1000$8$1$${parts[4]}$${parts[5]}`, // not a power of two
      `scrypt$1024$99$1$${parts[4]}$${parts[5]}`,
      `scrypt$1024$8$9$${parts[4]}$${parts[5]}`,
      good.replace(/\$[A-Za-z0-9_-]{43}$/, "$short"),
    ]) assert.equal(await verifyPassword(bad, PW), false, bad);
  });

  it("policy: length only", () => {
    assert.equal(passwordProblem("x".repeat(MIN_USER_PASSWORD_CHARS - 1)), "too_short");
    assert.equal(passwordProblem("x".repeat(MIN_USER_PASSWORD_CHARS)), null);
    assert.equal(passwordProblem("x".repeat(MAX_USER_PASSWORD_CHARS + 1)), "too_long");
    assert.equal(passwordProblem(undefined), "not_a_string");
    assert.equal(passwordProblem(12345678901234), "not_a_string");
  });

  it("dummy hash is valid and the same object each time (unknown emails cost one scrypt run)", async () => {
    const d = await dummyHash();
    assert.equal(d, await dummyHash());
    assert.match(d, /^scrypt\$/);
    assert.equal(await verifyPassword(d, PW), false);
  });
});
