import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DecisionsResponse } from "@openrouter/sdk/models";
import { JEV_MAX_ATTEMPTS, JEV_MODEL, QUESTION_SET_VERSION, QUESTION_SET_VERSION_V3, SCHEDULER_TICK_MS } from "./constants.ts";
import { parseMessage, type ImapPort, type TransientInput } from "./imap.ts";
import type { JevClient } from "./jev.ts";
import { buildState, QUESTIONS, questionsFor, questionsV3, type JevQuestion } from "./jev-questions.ts";
import type { TopicList } from "./topics.ts";
import { feedbackHistory, recordJevSpam } from "./senders.ts";
import { accountUserId } from "./tenant.ts";
import { backoffMs, classifyFailure } from "./retry-policy.ts";
import { interpretNoul, normalizeAnswers, type NormalizedAnswer } from "./jev-response.ts";
import { assertCalibrationMatchesQuestions, calibrationFor, NOUL_CALIBRATIONS, NoulCalibrationError } from "./noul-calibration.ts";
import { DEFAULT_CLASSIFIER, isClassifierModel, LUNA_CLASSIFIER } from "./classifier-models.ts";
import { computeShadowQuarantine, type ShadowQuarantine } from "./shadow.ts";

// Start-up check (O8): the calibration must belong to the question set this pipeline asks.
const defaultCalibration = calibrationFor(QUESTION_SET_VERSION);
if (defaultCalibration === null) throw new NoulCalibrationError("noul_calibration_mismatch", "question_set_version");
assertCalibrationMatchesQuestions(
  defaultCalibration,
  QUESTION_SET_VERSION,
  Object.entries(QUESTIONS).filter(([, q]) => q.type === "noul").map(([k]) => k),
);

// Every shipped calibration (v1, v2, v3 per model) must match the noul questions of its own question set.
for (const cal of NOUL_CALIBRATIONS) {
  assertCalibrationMatchesQuestions(
    cal,
    cal.question_set_version,
    Object.entries(questionsFor(cal.question_set_version)).filter(([, q]) => q.type === "noul").map(([k]) => k),
  );
}

/** Thrown by persistResponse to reject an invalid response: the pipeline rolls back and marks the row failed. */
export class ResponseRejectedError extends Error {
  readonly failureCode: string;
  constructor(failureCode: string) {
    super(failureCode);
    this.name = "ResponseRejectedError";
    this.failureCode = failureCode;
  }
}

/**
 * Standard persistResponse: normalized answers + derived shadow_quarantine + audit, all inside the caller's
 * transaction. Stores only normalized values (no excerpt, no raw response, no extra SDK fields).
 */
export function createPersistResponse(spamThresholdFor: (accountId: string) => number) {
  return (ctx: ClassifiedContext): void => {
    // The question set (and, for v3, the user's topic options) this classification was asked with; default v2.
    const version = ctx.questionSetVersion ?? QUESTION_SET_VERSION;
    const n = normalizeAnswers(ctx.response.answers, ctx.questions ?? QUESTIONS);
    if (!n.ok) throw new ResponseRejectedError(`invalid_response_${n.code}`);
    persistNormalizedAnswers(ctx, n.answers, spamThresholdFor(ctx.accountId), "pipeline", version, ctx.model);
    // v3: the topic list version the answer belongs to (the options Jev saw), so that old answers keep their meaning.
    if (ctx.topicListVersion) {
      ctx.db.prepare("UPDATE classifications SET topic_list_version = ? WHERE id = ?").run(ctx.topicListVersion, ctx.classificationId);
    }
    // E7: Jev's spam verdicts per sender feed the HITL question. Same transaction as the answers.
    const spam = n.answers.find((a) => a.key === "is_spam");
    if (spam && interpretNoul(spam, version, ctx.model) === "positive") {
      recordJevSpam(ctx.db, ctx.emailId, ctx.classificationId, ctx.now.toISOString());
    }
  };
}

/**
 * Shared by the pipeline and the synthetic dev import (actor "eval"): inserts the normalized answers, the derived
 * shadow_quarantine and its audit row. Runs inside the caller's transaction; the caller owns row replacement.
 */
export function persistNormalizedAnswers(
  ctx: Pick<ClassifiedContext, "db" | "classificationId" | "emailId" | "accountId" | "traceId" | "now">,
  answers: NormalizedAnswer[],
  spamThreshold: number,
  actor: "pipeline" | "eval",
  questionSetVersion: string,
  model: string = DEFAULT_CLASSIFIER,
): ShadowQuarantine {
  const ins = ctx.db.prepare(
    "INSERT INTO classification_answers (classification_id, question_key, type, answer_json, probabilities_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const a of answers) {
    ins.run(ctx.classificationId, a.key, a.type, JSON.stringify({ value: a.value }),
      a.probabilities ? JSON.stringify(a.probabilities) : null);
  }
  const shadow = computeShadowQuarantine(answers, spamThreshold, undefined, questionSetVersion, model);
  ins.run(ctx.classificationId, "shadow_quarantine", "derived", JSON.stringify(shadow), null);
  ctx.db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
     VALUES (?, ?, ?, 'shadow_quarantine_computed', ?, ?, ?)`,
  ).run(ctx.now.toISOString(), ctx.traceId, actor, ctx.accountId, ctx.emailId,
    JSON.stringify({ candidate: shadow.candidate, decision: shadow.decision, reason: shadow.reason }));
  return shadow;
}

export interface SchedulerClock {
  now(): Date;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: SchedulerClock = {
  now: () => new Date(),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Extension point for T16. Called inside the DB transaction that marks the row `classified`;
 * persist answers (and derived rules) here. Throwing rolls the whole transaction back.
 * Never persist excerpt/body/raw response.
 */
export interface ClassifiedContext {
  db: DatabaseSync;
  classificationId: number;
  emailId: number;
  accountId: string;
  /** The model this classification was requested from (classifications.model_requested). */
  model: string;
  /** Question set of this classification (the row's version). Absent = the default (v2). */
  questionSetVersion?: string;
  /** The questions that were sent (v3: with the owner's topic options). Absent = the default set. */
  questions?: Record<string, JevQuestion>;
  /** v3 only: version of the topic list that was sent (stored in classifications.topic_list_version). */
  topicListVersion?: string | null;
  response: DecisionsResponse;
  latencyMs: number;
  attempts: number;
  traceId: string;
  now: Date;
}

export interface PipelineOptions {
  db: DatabaseSync;
  clock?: SchedulerClock;
  /** Jev (System One): the default classifier. */
  jev: JevClient;
  /** Client for `openai/gpt-6-luna-decisions` (packages/core/src/decisions-client.ts). Absent = that model falls back to Jev. */
  decisions?: JevClient;
  /** The classifier model of the account's owner (ADR 0041). Absent = Jev. Only allowlisted models with a client are used. */
  modelFor?: (accountId: string) => string;
  /** Creates a read-only IMAP port for a retry refetch. The pipeline connects and closes it. */
  portFactory: (accountId: string) => ImapPort;
  persistResponse?: (ctx: ClassifiedContext) => void;
  /**
   * Called after the classification is committed (ids only). Errors, sync or async, are swallowed: a consumer such as
   * the mailbox rules must never fail or roll back a classification.
   */
  onClassified?: (info: { emailId: number; accountId: string }) => void | Promise<void>;
  accountContext?: (accountId: string) => string | undefined;
  /**
   * Topics (R8, ADR 0037): has the owner of this account switched `topics_enabled` on? Only then do NEW classifications use
   * the question set v3. Absent = never (v2).
   */
  topicsEnabled?: (accountId: string) => boolean;
  /** The option list of the account's owner (fixed plus active custom topics). Needed for every v3 request, also a retry. */
  topicList?: (accountId: string) => TopicList;
  tickMs?: number;
}

export interface ClassificationPipeline {
  /** Creates (idempotently) the classification row and makes the first attempt with the in-memory excerpt. */
  submit(i: { emailId: number; accountId: string; input: TransientInput }): Promise<void>;
  /** Resets paused rows to pending, processes due rows, starts the timer. */
  start(): Promise<void>;
  stop(): void;
  /** Processes all currently due rows (serially). */
  tick(): Promise<void>;
}

interface Row {
  id: number;
  email_id: number;
  account_id: string;
  attempts: number;
  model: string;
  question_set_version: string;
}

export function createClassificationPipeline(opts: PipelineOptions): ClassificationPipeline {
  const { db } = opts;
  const clientFor = (model: string): JevClient | undefined =>
    model === JEV_MODEL ? opts.jev : model === LUNA_CLASSIFIER ? opts.decisions : undefined;
  /** Model for a new classification: the owner's choice if it is on the allowlist and has a client, else Jev. */
  const chooseModel = (accountId: string): string => {
    let m: string = JEV_MODEL;
    try {
      m = opts.modelFor?.(accountId) ?? JEV_MODEL;
    } catch {
      m = JEV_MODEL;
    }
    return isClassifierModel(m) && clientFor(m) !== undefined ? m : JEV_MODEL;
  };
  /** Question set for a new classification: v3 only with the owner's switch on AND a valid topic list, else the default v2. */
  const chooseQuestionSet = (accountId: string): string => {
    try {
      if (opts.topicsEnabled?.(accountId) === true && opts.topicList?.(accountId).ok === true) return QUESTION_SET_VERSION_V3;
    } catch {
      // fall through to v2
    }
    return QUESTION_SET_VERSION;
  };
  const clock = opts.clock ?? systemClock;
  const cache = new Map<number, TransientInput>();
  let paused = false;
  let timer: unknown;
  let chain: Promise<void> = Promise.resolve();

  const iso = () => clock.now().toISOString();
  const audit = (action: string, traceId: string, accountId: string, emailId: number, details: Record<string, unknown>) =>
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
       VALUES (?, ?, 'pipeline', ?, ?, ?, ?)`,
    ).run(iso(), traceId, action, accountId, emailId, JSON.stringify(details));

  function setStatus(id: number, status: string, f: { failureCode?: string | null; attempts?: number; next?: string | null }) {
    db.prepare(
      `UPDATE classifications SET status = ?, failure_code = ?, attempts = COALESCE(?, attempts),
         next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    ).run(status, f.failureCode ?? null, f.attempts ?? null, f.next ?? null, iso(), id);
  }

  async function refetch(row: Row, traceId: string): Promise<TransientInput | "source_gone" | "error"> {
    const loc = db.prepare(
      "SELECT folder, uid, uid_validity FROM email_locations WHERE email_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1",
    ).get(row.email_id) as { folder: string; uid: number; uid_validity: number } | undefined;
    if (!loc) return "source_gone";
    const port = opts.portFactory(row.account_id);
    try {
      await port.connect();
      const status = await port.mailboxStatus(loc.folder);
      if (status.uidValidity !== loc.uid_validity) return "source_gone";
      const raw = await port.fetchMessageByUid(loc.folder, loc.uid);
      if (!raw) return "source_gone";
      const parsed = await parseMessage(raw.source);
      return { ...parsed.meta, excerpt: parsed.excerpt };
    } catch {
      void traceId;
      return "error";
    } finally {
      await port.close().catch(() => {});
    }
  }

  /** Questions of a classification: the default v2, or v3 with the owner's current topic list. null = v3 without a usable list. */
  function questionsOf(accountId: string, version: string): { questions: Record<string, JevQuestion>; topicListVersion: string | null } | null {
    if (version !== QUESTION_SET_VERSION_V3) return { questions: QUESTIONS, topicListVersion: null };
    try {
      const list = opts.topicList?.(accountId);
      if (!list || !list.ok) return null;
      return { questions: questionsV3(list.options), topicListVersion: list.version };
    } catch {
      return null;
    }
  }

  function buildRequest(accountId: string, input: TransientInput, questions: Record<string, JevQuestion>) {
    const at = input.sender.lastIndexOf("@");
    const ctx = opts.accountContext?.(accountId);
    // T55/H21: two numbers, only for an authenticated sender (DMARC pass) with feedback; otherwise absent.
    const history = feedbackHistory(db, accountUserId(db, accountId), input.sender, input.dmarc);
    return {
      questions,
      state: buildState({
        ...(ctx !== undefined ? { account_context: ctx } : {}),
        ...(at >= 0 ? { sender_domain: input.sender.slice(at + 1) } : {}),
        spf: input.spf,
        dkim: input.dkim,
        dmarc: input.dmarc,
        list_unsubscribe_present: input.listUnsubscribePresent,
        reply_to_differs_from_from: input.replyToDiffersFromFrom,
        ...(history ? { sender_history: history } : {}),
        untrusted_subject: input.subject,
        untrusted_body: input.excerpt,
      }),
    };
  }

  function handleRetryOrFail(row: Row, attempts: number, failureCode: string, traceId: string) {
    if (attempts >= JEV_MAX_ATTEMPTS) {
      setStatus(row.id, "failed", { failureCode: "max_attempts", attempts });
      audit("classification_failed", traceId, row.account_id, row.email_id, { failure_code: "max_attempts", last: failureCode });
      return;
    }
    const next = new Date(clock.now().getTime() + backoffMs(attempts)).toISOString();
    setStatus(row.id, "retry_wait", { failureCode, attempts, next });
  }

  async function processRow(row: Row): Promise<void> {
    if (paused) return;
    const traceId = randomUUID();
    let input = cache.get(row.id);
    cache.delete(row.id); // excerpt is dropped after the first attempt
    if (!input) {
      const r = await refetch(row, traceId);
      if (r === "source_gone") {
        setStatus(row.id, "failed", { failureCode: "source_gone" });
        audit("source_gone", traceId, row.account_id, row.email_id, {});
        return;
      }
      if (r === "error") {
        handleRetryOrFail(row, row.attempts + 1, "refetch_error", traceId);
        return;
      }
      input = r;
    }
    const started = clock.now().getTime();
    const client = clientFor(row.model);
    if (!client) {
      setStatus(row.id, "failed", { failureCode: "model_unavailable", attempts: row.attempts });
      audit("classification_failed", traceId, row.account_id, row.email_id, { failure_code: "model_unavailable" });
      return;
    }
    const asked = questionsOf(row.account_id, row.question_set_version);
    if (!asked) {
      handleRetryOrFail(row, row.attempts + 1, "topic_list_unavailable", traceId);
      return;
    }
    const result = await client.classify(buildRequest(row.account_id, input, asked.questions));
    const latencyMs = Math.max(0, clock.now().getTime() - started);
    const attempts = row.attempts + 1;

    if (result.ok) {
      db.exec("BEGIN");
      try {
        db.prepare(
          `UPDATE classifications SET status = 'classified', model_reported = ?, latency_ms = ?, attempts = ?,
             failure_code = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(result.response.model, latencyMs, attempts, iso(), row.id);
        opts.persistResponse?.({
          db, classificationId: row.id, emailId: row.email_id, accountId: row.account_id, model: row.model,
          questionSetVersion: row.question_set_version, questions: asked.questions, topicListVersion: asked.topicListVersion,
          response: result.response, latencyMs, attempts, traceId, now: clock.now(),
        });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        if (e instanceof ResponseRejectedError) {
          setStatus(row.id, "failed", { failureCode: e.failureCode, attempts });
          audit("classification_failed", traceId, row.account_id, row.email_id, { failure_code: e.failureCode });
          return;
        }
        throw e;
      }
      try {
        await opts.onClassified?.({ emailId: row.email_id, accountId: row.account_id });
      } catch {
        // see PipelineOptions.onClassified
      }
      return;
    }

    const decision = classifyFailure(result);
    if (decision.action === "pause") {
      paused = true;
      setStatus(row.id, "paused", { failureCode: decision.failureCode });
      audit("jev_paused", traceId, row.account_id, row.email_id, { failure_code: decision.failureCode });
    } else if (decision.action === "fail") {
      setStatus(row.id, "failed", { failureCode: decision.failureCode, attempts });
    } else {
      handleRetryOrFail(row, attempts, decision.failureCode, traceId);
    }
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn);
    chain = p.then(() => {}, () => {});
    return p;
  }

  async function runDue(): Promise<void> {
    if (paused) return;
    const rows = db.prepare(
      `SELECT c.id, c.email_id, c.attempts, c.model_requested AS model, c.question_set_version, e.account_id FROM classifications c JOIN emails e ON e.id = c.email_id
       WHERE c.status = 'pending' OR (c.status = 'retry_wait' AND c.next_attempt_at <= ?)
       ORDER BY c.id`,
    ).all(iso()) as unknown as Row[];
    for (const row of rows) {
      if (paused) return;
      await processRow(row);
    }
  }

  return {
    submit({ emailId, accountId, input }) {
      return enqueue(async () => {
        const ts = iso();
        const model = chooseModel(accountId);
        const version = chooseQuestionSet(accountId);
        db.prepare(
          `INSERT OR IGNORE INTO classifications
             (email_id, question_set_version, model_requested, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
        ).run(emailId, version, model, ts, ts);
        const r = db.prepare(
          "SELECT id, email_id, attempts, model_requested AS model, question_set_version FROM classifications WHERE email_id = ? AND question_set_version = ? AND model_requested = ?",
        ).get(emailId, version, model) as unknown as Omit<Row, "account_id">;
        const status = db.prepare("SELECT status FROM classifications WHERE id = ?").get(r.id) as { status: string };
        if (status.status !== "pending") return;
        cache.set(r.id, input);
        await processRow({ ...r, account_id: accountId });
      });
    },
    start() {
      return enqueue(async () => {
        paused = false;
        db.prepare("UPDATE classifications SET status = 'pending', updated_at = ? WHERE status = 'paused'").run(iso());
        if (timer === undefined) {
          timer = clock.setInterval(() => { void enqueue(runDue).catch(() => {}); }, opts.tickMs ?? SCHEDULER_TICK_MS);
        }
        await runDue();
      });
    },
    stop() {
      if (timer !== undefined) clock.clearInterval(timer);
      timer = undefined;
    },
    tick() {
      return enqueue(runDue);
    },
  };
}
