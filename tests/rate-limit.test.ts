import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../lib/rate-limit.ts";

test("allows up to the limit per key within the window, then reports retry-after", () => {
  let now = 1000;
  const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  for (let i = 0; i < 3; i++) assert.deepEqual(rl.check("nico"), { allowed: true, remaining: 2 - i });
  assert.deepEqual(rl.check("nico"), { allowed: false, retryAfterMs: 60_000 });
  now += 10_000;
  assert.deepEqual(rl.check("nico"), { allowed: false, retryAfterMs: 50_000 });
});

test("keys are independent", () => {
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, false);
  assert.equal(rl.check("b").allowed, true);
});

test("sliding window: old hits expire", () => {
  let now = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  rl.check("k"); now = 500; rl.check("k");
  now = 999;
  assert.equal(rl.check("k").allowed, false);
  now = 1000;
  assert.deepEqual(rl.check("k"), { allowed: true, remaining: 0 });
});

test("a rejected request does not extend the block", () => {
  let now = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  rl.check("k");
  for (now = 100; now < 1000; now += 100) assert.equal(rl.check("k").allowed, false);
  now = 1000;
  assert.equal(rl.check("k").allowed, true);
});

test("memory stays bounded: idle keys are dropped and the key count is capped", () => {
  let now = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now, maxKeys: 3 });
  for (const k of ["a", "b", "c"]) rl.check(k);
  assert.equal(rl.size(), 3);
  assert.equal(rl.check("d").allowed, false, "unknown keys are refused when full (fail-closed)");
  now = 5000;
  assert.equal(rl.check("d").allowed, true, "expired keys are swept first");
  assert.equal(rl.size(), 1);
});

test("invalid options are rejected", () => {
  assert.throws(() => createRateLimiter({ limit: 0, windowMs: 1000 }), /limit/);
  assert.throws(() => createRateLimiter({ limit: 1, windowMs: 0 }), /windowMs/);
});
