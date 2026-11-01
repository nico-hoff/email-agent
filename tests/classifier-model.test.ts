// R3 / ADR 0041: classifier model per user. Fake clients, synthetic data, no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { ImapPort, MessageMeta, TransientInput } from "../lib/imap.ts";
import type { JevCallResult, JevClient } from "../lib/jev.ts";
import { createClassificationPipeline, createPersistResponse } from "../lib/classification-pipeline.ts";
import { CLASSIFIER_MODELS, DEFAULT_CLASSIFIER, isClassifierModel, JEV_CLASSIFIER, LUNA_CLASSIFIER, relativeCost } from "../lib/classifier-models.ts";
import { JEV_MODEL, QUESTION_SET_VERSION } from "../lib/constants.ts";
import { LUNA_DECISIONS_MODEL } from "../lib/decisions-client.ts";
import { interpretNoul } from "../lib/jev-response.ts";
import { calibrationFor, NOUL_CALIBRATIONS, parseNoulCalibrations } from "../lib/noul-calibration.ts";
import {
  classifierModelFor, isSelectableModel, readUserSettings, setClassifierChoice, setClassifierModel, setUserStop, userStopped,
} from "../lib/user-settings.ts";
import shipped from "../config/noul-calibration.ts";

const T0 = new Date("2026-10-31T12:00:00.000Z");
const meta: MessageMeta = {
  messageId: "<m1>", sender: "s@example.test", subject: "subj", receivedAt: "2026-10-31T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
};
const input: TransientInput = { ...meta, excerpt: "x" };
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/jev-email-v2-response.json", import.meta.url), "utf8"));
const ok = (model: string): JevCallResult => ({ ok: true, response: { ...fixture(), model } as never });

describe("allowlist", () => {
  it("constants equal the client constants; Jev is the default", () => {
    assert.equal(JEV_CLASSIFIER, JEV_MODEL);
    assert.equal(LUNA_CLASSIFIER, LUNA_DECISIONS_MODEL);
    assert.equal(DEFAULT_CLASSIFIER, JEV_MODEL);
    assert.deepEqual(CLASSIFIER_MODELS.map((m) => m.id), [JEV_MODEL, LUNA_DECISIONS_MODEL]);
    assert.equal(isClassifierModel("openai/gpt-5"), false);
    assert.equal(relativeCost(CLASSIFIER_MODELS[0]!), 1);
    assert.ok(relativeCost(CLASSIFIER_MODELS[1]!) > 1);
  });

  it("offline gate: every selectable model has a calibration for the default question set; the default always does", () => {
    assert.ok(calibrationFor(QUESTION_SET_VERSION, DEFAULT_CLASSIFIER));
    for (const m of CLASSIFIER_MODELS) {
      assert.equal(isSelectableModel(m.id), calibrationFor(QUESTION_SET_VERSION, m.id) !== null, m.id);
    }
    assert.equal(isSelectableModel(DEFAULT_CLASSIFIER), true);
  });

  it("every calibration entry names an allowlisted model", () => {
    for (const c of NOUL_CALIBRATIONS) assert.ok(isClassifierModel(c.model), c.version);
  });
});

describe("calibration per (question set, model)", () => {
  it("a model without an entry reads every noul answer as unmapped (fail-closed)", () => {
    const a = { key: "is_spam", type: "noul" as const, value: 0.99 };
    assert.equal(interpretNoul(a, QUESTION_SET_VERSION, JEV_MODEL), "positive");
    assert.equal(interpretNoul(a, QUESTION_SET_VERSION), "positive", "no model = Jev");
    assert.equal(interpretNoul(a, QUESTION_SET_VERSION, "some/uncalibrated-model"), "unmapped");
    assert.equal(interpretNoul(a, QUESTION_SET_VERSION, ""), "unmapped");
  });

  it("the same question set and model twice is invalid; a second model for the same set is fine", () => {
    const e0 = structuredClone(shipped[0]);
    const other = { ...structuredClone(shipped[0]), version: "99", model: "openai/gpt-6-luna-decisions" };
    assert.equal(parseNoulCalibrations([e0, other]).length, 2);
    assert.throws(() => parseNoulCalibrations([e0, { ...e0, version: "99" }]));
    assert.throws(() => parseNoulCalibrations([{ ...e0, model: undefined }]));
  });
});

describe("user settings", () => {
  const db = () => {
    const d = openDatabase(":memory:");
    d.exec(`INSERT INTO users (id,email,password_hash,role,status,created_at,updated_at) VALUES (2,'b@x.test','${"h".repeat(40)}','user','active','t','t')`);
    return d;
  };

  it("defaults: no permission, no stop, Jev", () => {
    const d = db();
    assert.deepEqual(readUserSettings(d, 2), { classifier_choice: false, classifier_model: null, stopped_at: null });
    assert.equal(userStopped(d, 2), false);
    assert.equal(classifierModelFor(d, 2), JEV_MODEL);
  });

  it("choosing needs the permission, an allowlisted and calibrated model; revoking falls back to Jev at once", () => {
    const d = db();
    assert.equal(setClassifierModel(d, 2, JEV_MODEL, T0), "no_permission");
    setClassifierChoice(d, 2, true, T0);
    assert.equal(setClassifierModel(d, 2, "evil/model", T0), "invalid_model");
    const luna = setClassifierModel(d, 2, LUNA_CLASSIFIER, T0);
    assert.equal(luna, isSelectableModel(LUNA_CLASSIFIER) ? "ok" : "not_calibrated");
    assert.equal(classifierModelFor(d, 2), isSelectableModel(LUNA_CLASSIFIER) ? LUNA_CLASSIFIER : JEV_MODEL);
    setClassifierChoice(d, 2, false, T0);
    assert.equal(classifierModelFor(d, 2), JEV_MODEL);
  });

  it("a stored model that is not selectable is ignored", () => {
    const d = db();
    setClassifierChoice(d, 2, true, T0);
    d.prepare("UPDATE user_settings SET classifier_model = 'old/removed-model' WHERE user_id = 2").run();
    assert.equal(classifierModelFor(d, 2), JEV_MODEL);
  });

  it("the user stop is per user", () => {
    const d = db();
    setUserStop(d, 2, true, T0);
    assert.equal(userStopped(d, 2), true);
    assert.equal(userStopped(d, 1), false);
    setUserStop(d, 2, false, T0);
    assert.equal(userStopped(d, 2), false);
  });
});

describe("pipeline picks the client by the account owner's model", () => {
  function setup(modelFor: (accountId: string) => string, withDecisions = true) {
    const db = openDatabase(":memory:");
    syncAccounts(db, [{ id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p", mailbox: "INBOX", spam_threshold: 0.9, enabled: true } as never]);
    const { emailId } = ingestMail(db, { accountId: "a", meta, loc: { folder: "INBOX", uid: 7, uidValidity: 1 }, now: T0, traceId: "t" });
    const calls: string[] = [];
    const fakeClient = (name: string, model: string): JevClient => ({ classify: async () => { calls.push(name); return ok(model); } });
    const pipeline = createClassificationPipeline({
      db,
      jev: fakeClient("jev", JEV_MODEL),
      ...(withDecisions ? { decisions: fakeClient("luna", LUNA_CLASSIFIER) } : {}),
      modelFor,
      portFactory: () => ({}) as ImapPort,
      clock: { now: () => T0, setInterval: () => 0, clearInterval: () => {} },
      persistResponse: createPersistResponse(() => 0.9),
    });
    return { db, pipeline, emailId, calls };
  }
  const requested = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT model_requested, status FROM classifications").all().map((r) => [r.model_requested, r.status]);

  it("Jev owner: the Jev client, model_requested = Jev", async () => {
    const s = setup(() => JEV_MODEL);
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    assert.deepEqual(s.calls, ["jev"]);
    assert.deepEqual(requested(s.db), [[JEV_MODEL, "classified"]]);
  });

  it("Luna owner: the decisions client, model_requested = Luna", async () => {
    const s = setup(() => LUNA_CLASSIFIER);
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    assert.deepEqual(s.calls, ["luna"]);
    assert.deepEqual(requested(s.db), [[LUNA_CLASSIFIER, "classified"]]);
  });

  it("an unknown model, a throwing lookup or a missing decisions client fall back to Jev", async () => {
    for (const [mf, dec] of [[() => "evil/model", true], [() => { throw new Error("x"); }, true], [() => LUNA_CLASSIFIER, false]] as const) {
      const s = setup(mf, dec);
      await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
      assert.deepEqual(s.calls, ["jev"]);
      assert.deepEqual(requested(s.db), [[JEV_MODEL, "classified"]]);
    }
  });

  it("switching does not reclassify: the old row stays, a retry keeps the model of its row", async () => {
    let model = JEV_MODEL;
    const s = setup(() => model);
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    model = LUNA_CLASSIFIER;
    await s.pipeline.tick();
    assert.deepEqual(s.calls, ["jev"], "tick does not touch classified rows");
    assert.deepEqual(requested(s.db), [[JEV_MODEL, "classified"]]);
  });
});
