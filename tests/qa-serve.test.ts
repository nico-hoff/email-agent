import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { openDatabase } from "../lib/db.ts";
import { verifyLogin } from "../lib/users.ts";
import {
  ensureQaUser, parseQaArgs, profileForTopic, QA_NO_ACCOUNTS_FILE, QA_USER_EMAIL, qaItems, qaServerEnv, seedQaDatabase,
} from "../scripts/qa-serve.ts";

const dir = mkdtempSync(join(tmpdir(), "qa-serve-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("qa-serve", () => {
  test("items: three per topic from the synthetic fixture plus the smoke set, never a body", () => {
    const items = qaItems();
    assert.ok(items.length >= 16 * 3);
    for (const it of items) {
      assert.match(it.case.sender_domain, /\.example\.test$/);
      assert.ok(it.classification !== undefined);
    }
    assert.ok(items.filter((i) => i.case.id.startsWith("qa-")).every((i) => i.case.body === ""));
  });

  test("profiles spread over the views", () => {
    assert.equal(profileForTopic("newsletter", 0).category, "newsletter_promo");
    assert.equal(profileForTopic("work", 0).route, "draft_reply");
    assert.equal(profileForTopic("health", 0).urgency, 3);
    assert.equal(profileForTopic("unknown-topic", 0).category, "business");
  });

  test("seeds an empty database once, then keeps it; QA user claims the owner and can log in", async () => {
    const db = openDatabase(join(dir, "qa.sqlite"));
    try {
      const first = seedQaDatabase(db);
      assert.equal(first.seeded, true);
      assert.equal(seedQaDatabase(db).seeded, false);
      const pw = await ensureQaUser(db, "qa-test-password-123");
      assert.equal(pw, "qa-test-password-123");
      assert.equal(await ensureQaUser(db), null);
      const u = await verifyLogin(db, QA_USER_EMAIL, "qa-test-password-123");
      assert.equal(u?.id, 1);
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = 1").get() as { n: number };
      assert.ok(n > 0);
    } finally {
      db.close();
    }
  });

  test("server env: users mode, loopback, no accounts file", () => {
    const env = qaServerEnv({ APP_PASSWORD: "x" }, "/tmp/qa.sqlite", 3100);
    assert.equal(env.AUTH_MODE, "users");
    assert.equal(env.ACCOUNTS_FILE, QA_NO_ACCOUNTS_FILE);
    assert.equal(env.BIND_ADDRESS, "127.0.0.1");
    assert.equal(env.PORT, "3100");
  });

  test("args", () => {
    assert.deepEqual(parseQaArgs([]), { reset: false, port: 3000 });
    assert.deepEqual(parseQaArgs(["--reset", "--port", "3100"]), { reset: true, port: 3100 });
    assert.ok("error" in parseQaArgs(["--port", "80"]));
    assert.ok("error" in parseQaArgs(["--bogus"]));
  });
});
