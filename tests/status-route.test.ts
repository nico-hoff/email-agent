import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { GET } from "../app/api/status/route.ts";

test("GET /api/status reads worker state and classification counts from SQLite only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "t.sqlite");
  const prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = file;
  try {
    const db = openDatabase(file);
    syncAccounts(db, [
      { id: "a1", label: "Secret Label", host: "imap.secret.example", port: 993, mailbox: "INBOX", enabled: true },
    ] as never);
    db.prepare("UPDATE worker_status SET state='connected', last_event_at='e', last_poll_at='p', error_code=NULL WHERE account_id='a1'").run();
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a1','m','who@secret.example','TOPSECRET','t','t')").run();
    db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, status, attempts, created_at, updated_at) VALUES (1,'v','m','pending',0,'t','t')").run();
    db.close();
    const res = await GET();
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const bad of ["secret", "TOPSECRET", "who@", "Secret Label"]) assert.ok(!text.includes(bad), bad);
    const body = JSON.parse(text);
    assert.deepEqual(body.workers, [
      { account_id: "a1", state: "connected", last_event_at: "e", last_poll_at: "p", error_code: null },
    ]);
    assert.deepEqual(body.classifications, { pending: 1, retry_wait: 0, classified: 0, failed: 0, paused: 0 });
  } finally {
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
