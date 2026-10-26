import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJevClient } from "../lib/jev.ts";
import { createLimiter } from "../lib/limiter.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";
import { JEV_MODEL } from "../lib/constants.ts";

const response = { answers: {}, model: "m", usage: { inputTokens: 1, outputTokens: 2 } };

function make(fn: (client: unknown, req: any, opts: any) => Promise<any>) {
  return createJevClient({ apiKey: "test-key", client: { fake: true } as any, systemOneCreate: fn as any });
}

describe("jev client", () => {
  it("sends questions, state, model and disables SDK retries", async () => {
    let seen: any;
    const jev = make(async (client, req, opts) => {
      seen = { client, req, opts };
      return { ok: true, value: response };
    });
    const r = await jev.classify({ questions: QUESTIONS, state: { sender_domain: "example.test" } });
    assert.deepEqual(seen.client, { fake: true });
    assert.equal(seen.req.decisionsRequest.model, JEV_MODEL);
    assert.equal(seen.req.decisionsRequest.questions, QUESTIONS);
    assert.deepEqual(seen.req.decisionsRequest.state, { sender_domain: "example.test" });
    assert.deepEqual(seen.opts.retries, { strategy: "none" });
    assert.ok(r.ok);
    assert.equal(r.response, response);
  });

  it("never treats res.ok === false as success and reads statusCode", async () => {
    const err = Object.assign(new Error("boom"), { statusCode: 429 });
    const r = await make(async () => ({ ok: false, error: err })).classify({ questions: QUESTIONS, state: {} });
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.statusCode, 429);
    assert.equal(r.kind, "http");
  });

  it("classifies SDK errors without statusCode as transport", async () => {
    const r = await make(async () => ({ ok: false, error: new Error("x") })).classify({ questions: QUESTIONS, state: {} });
    assert.ok(!r.ok);
    assert.equal(r.statusCode, undefined);
    assert.equal(r.kind, "transport");
  });

  it("catches thrown transport errors", async () => {
    const r = await make(async () => {
      throw new TypeError("network");
    }).classify({ questions: QUESTIONS, state: {} });
    assert.ok(!r.ok);
    assert.equal(r.kind, "transport");
    assert.equal(r.errorName, "TypeError");
  });

  it("rejects an ok result without a value", async () => {
    const r = await make(async () => ({ ok: true })).classify({ questions: QUESTIONS, state: {} });
    assert.ok(!r.ok);
  });

  it("allows at most one call at a time", async () => {
    let running = 0;
    let peak = 0;
    const jev = make(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { ok: true, value: response };
    });
    await Promise.all([1, 2, 3].map(() => jev.classify({ questions: QUESTIONS, state: {} })));
    assert.equal(peak, 1);
  });
});

describe("limiter", () => {
  it("runs queued tasks in order and survives rejections", async () => {
    const run = createLimiter(1);
    const order: number[] = [];
    const a = run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
      throw new Error("x");
    });
    const b = run(async () => {
      order.push(2);
      return "b";
    });
    await assert.rejects(a);
    assert.equal(await b, "b");
    assert.deepEqual(order, [1, 2]);
  });
});
