import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import {
  buildCalibrationReport,
  formatCalibrationReport,
  parseCalibrateArgs,
  quantiles,
  THRESHOLDS,
} from "../scripts/calibrate.ts";

const T = "2026-10-26T10:00:00.000Z";
const V1 = "email-classification-v1";
const V2 = "email-classification-v2";
const MODEL = "typesafe/jev-1.13";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "calibrate-"));
  chmodSync(dir, 0o700);
  const db = openDatabase(join(dir, "t.sqlite"));
  syncAccounts(db, [
    { id: "a1", label: "L1", host: "imap.marker-host.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true },
    { id: "a2", label: "L2", host: "imap.two.example", port: 993, mailbox: "INBOX", enabled: true },
  ] as never);
  let clsId = 0;
  const mail = (id: number, acc: string, folder: string | null) => {
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, acc, `m${id}`, `MARKER_FROM_${id}@x.example`, `MARKER_SUBJECT_${id}`, T, T);
    if (folder !== null) {
      db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, acc, folder, 1, id, 1, T, T);
    }
  };
  const cls = (emailId: number, qsv: string, status: string, answers: Record<string, number>) => {
    const id = ++clsId;
    db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, failure_code, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, emailId, qsv, MODEL, status === "classified" ? MODEL : null, status, status === "failed" ? "x" : null, 1, T, T);
    const ins = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json, probabilities_json) VALUES (?,?,?,?,?)");
    for (const [k, v] of Object.entries(answers)) ins.run(id, k, "noul", JSON.stringify({ value: v }), null);
    ins.run(id, "category", "choice", JSON.stringify({ value: "spam" }), null);
    ins.run(id, "shadow_quarantine", "derived", JSON.stringify({ candidate: false }), null);
  };
  // a1 provider spam (Junk)
  mail(1, "a1", "Junk"); cls(1, V1, "classified", { is_spam: 0.9, needs_my_reply: 0.8 });
  mail(2, "a1", "Junk"); cls(2, V1, "classified", { is_spam: 0.6, needs_my_reply: 0.4 });
  // a1 provider not spam (INBOX)
  mail(3, "a1", "INBOX"); cls(3, V1, "classified", { is_spam: 0.7, needs_my_reply: 0.9 });
  mail(4, "a1", "INBOX"); cls(4, V1, "classified", { is_spam: 0.2, needs_my_reply: 0.1 });
  // excluded: account without spam_mailbox, email without active location
  mail(5, "a2", "INBOX"); cls(5, V1, "classified", { is_spam: 0.99, needs_my_reply: 0.99 });
  mail(6, "a1", null); cls(6, V1, "classified", { is_spam: 0.99, needs_my_reply: 0.99 });
  // ignored: not classified
  mail(7, "a1", "Junk"); cls(7, V1, "failed", {});
  // separate group: question set v2
  cls(1, V2, "classified", { is_spam: 0.95 });
  return { db, dir };
}

const close = (n: number, expected: number) => assert.ok(Math.abs(n - expected) < 1e-9, `${n} != ${expected}`);

test("quantiles use linear interpolation and handle empty and single inputs", () => {
  assert.equal(quantiles([]), null);
  assert.deepEqual(quantiles([0.4]), { n: 1, min: 0.4, p10: 0.4, median: 0.4, p90: 0.4, max: 0.4 });
  const q = quantiles([1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])!;
  assert.equal(q.n, 10);
  close(q.min, 0.1);
  close(q.p10, 0.19);
  close(q.median, 0.55);
  close(q.p90, 0.91);
  close(q.max, 1);
});

test("thresholds run from 0.50 to 0.95 in steps of 0.05", () => {
  assert.deepEqual(THRESHOLDS, [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]);
});

test("report gives per-folder distributions and precision/recall against the provider label", () => {
  const { db, dir } = setup();
  try {
    const report = buildCalibrationReport(db, {});
    assert.deepEqual(report.groups.map((g) => g.question_set_version), [V1, V2]);
    const g = report.groups[0];
    assert.equal(g.model_requested, MODEL);
    assert.deepEqual(g.emails, { provider_inbox: 2, provider_spam: 2 });
    assert.deepEqual(g.excluded, { no_active_location: 1, no_spam_mailbox: 1 });
    assert.deepEqual(g.questions.map((q) => q.key), ["is_spam", "needs_my_reply"]);

    const spam = g.questions[0];
    assert.equal(spam.distribution.provider_inbox!.n, 2);
    close(spam.distribution.provider_inbox!.min, 0.2);
    close(spam.distribution.provider_inbox!.median, 0.45);
    close(spam.distribution.provider_spam!.max, 0.9);

    const at = (t: number) => spam.thresholds.find((r) => r.threshold === t)!;
    assert.deepEqual({ ...at(0.5), precision: undefined, recall: undefined },
      { threshold: 0.5, tp: 2, fp: 1, fn: 0, tn: 1, precision: undefined, recall: undefined });
    close(at(0.5).precision!, 2 / 3);
    close(at(0.5).recall!, 1);
    assert.equal(at(0.8).tp, 1);
    assert.equal(at(0.8).fp, 0);
    close(at(0.8).precision!, 1);
    close(at(0.8).recall!, 0.5);
    assert.equal(at(0.95).precision, null, "no predicted positive -> precision undefined");
    assert.equal(at(0.95).recall, 0);

    assert.deepEqual(report.groups[1].emails, { provider_inbox: 0, provider_spam: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filters by question set and account", () => {
  const { db, dir } = setup();
  try {
    assert.deepEqual(buildCalibrationReport(db, { questionSet: V2 }).groups.map((g) => g.question_set_version), [V2]);
    const a2 = buildCalibrationReport(db, { account: "a2" });
    assert.deepEqual(a2.groups[0].emails, { provider_inbox: 0, provider_spam: 0 });
    assert.deepEqual(a2.groups[0].excluded, { no_active_location: 0, no_spam_mailbox: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report and its text never contain sender, subject or host", () => {
  const { db, dir } = setup();
  try {
    const report = buildCalibrationReport(db, {});
    const text = formatCalibrationReport(report);
    assert.match(text, /is_spam/);
    assert.match(text, /0\.67/);
    for (const out of [text, JSON.stringify(report)]) {
      assert.doesNotMatch(out, /MARKER_|marker-host|x\.example/);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI failure prints only error class and code, never paths or stack frames", () => {
  const base = mkdtempSync(join(tmpdir(), "calibrate-cli-"));
  try {
    // Parent exists with group/other access, so validateDatabasePath throws.
    const dir = join(base, "MARKERDIR");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const res = spawnSync(process.execPath, ["scripts/calibrate.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DATABASE_PATH: join(dir, "t.sqlite") },
    });
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stderr, /MARKERDIR/);
    assert.doesNotMatch(res.stderr, /\/home/);
    assert.doesNotMatch(res.stderr, /    at /);
    assert.match(res.stderr, /calibrate failed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parses CLI arguments strictly", () => {
  assert.deepEqual(parseCalibrateArgs([]), { json: false });
  assert.deepEqual(parseCalibrateArgs(["--question-set", V2, "--account", "a1", "--json"]),
    { questionSet: V2, account: "a1", json: true });
  assert.throws(() => parseCalibrateArgs(["--account"]), /bad_args/);
  assert.throws(() => parseCalibrateArgs(["--subject"]), /bad_args/);
});
