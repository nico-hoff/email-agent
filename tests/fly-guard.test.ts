import { test } from "node:test";
import assert from "node:assert/strict";
import { assertFlyAuthConfigured, FlyAuthMissingError } from "../lib/fly-guard.ts";
import { createService } from "../server.ts";

const LONG = "a-long-synthetic-test-passphrase";

test("outside fly nothing is required (tailnet mode stays possible)", () => {
  assert.doesNotThrow(() => assertFlyAuthConfigured({}));
  assert.doesNotThrow(() => assertFlyAuthConfigured({ FLY_APP_NAME: "" }));
  assert.doesNotThrow(() => assertFlyAuthConfigured({ APP_PASSWORD: "short" }));
});

test("on fly anything but a usable password mode refuses to start", () => {
  for (const pw of [undefined, "", "   ", "short", "fifteen-chars-x"]) {
    assert.throws(() => assertFlyAuthConfigured({ FLY_APP_NAME: "email-agent", APP_PASSWORD: pw }), FlyAuthMissingError);
  }
});

test("on fly with a usable APP_PASSWORD the check passes; messages carry no value", () => {
  assert.doesNotThrow(() => assertFlyAuthConfigured({ FLY_APP_NAME: "email-agent", APP_PASSWORD: LONG }));
  assert.throws(() => assertFlyAuthConfigured({ FLY_APP_NAME: "email-agent", APP_PASSWORD: "short-secret" }), (e: Error) => /APP_PASSWORD/.test(e.message) && !e.message.includes("short-secret"));
});

test("createService rejects before anything listens when on fly without a usable APP_PASSWORD", async () => {
  let listened = false;
  await assert.rejects(
    createService({
      port: 0, workers: false, env: { FLY_APP_NAME: "email-agent" },
      startHttp: async () => { listened = true; throw new Error("must not be called"); },
    }),
    FlyAuthMissingError,
  );
  assert.equal(listened, false);
});

test("createService starts on fly with a usable APP_PASSWORD", async () => {
  const svc = await createService({
    port: 0, workers: false, env: { FLY_APP_NAME: "email-agent", APP_PASSWORD: LONG }, log: () => {},
    startHttp: async () => ({ port: 1, url: "http://x", stop: async () => {} }),
    onSignal: () => {},
  });
  await svc.stop();
});
