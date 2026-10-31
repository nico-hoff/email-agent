import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DecisionsResponse } from "@openrouter/sdk/models";
import { JEV_MAX_ATTEMPTS, JEV_MODEL, QUESTION_SET_VERSION, SCHEDULER_TICK_MS } from "./constants.ts";
import { parseMessage, type ImapPort, type TransientInput } from "./imap.ts";
import type { JevClient } from "./jev.ts";
import { buildState, QUESTIONS } from "./jev-questions.ts";
import { feedbackHistory, recordJevSpam } from "./senders.ts";
import { backoffMs, classifyFailure } from "./retry-policy.ts";
import { interpretNoul, normalizeAnswers, type NormalizedAnswer } from "./jev-response.ts";
import { assertCalibrationMatchesQuestions, calibrationFor, NoulCalibrationError } from "./noul-calibration.ts";
import { computeShadowQuarantine, type ShadowQuarantine } from "./shadow.ts";

// Start-up check (O8): the calibration must belong to the question set this pipeline asks.
const defaultCalibration = calibrationFor(QUESTION_SET_VERSION);
if (defaultCalibration === null) throw new NoulCalibrationError("noul_calibration_mismatch", "question_set_version");
assertCalibrationMatchesQuestions(
  defaultCalibration,
  QUESTION_SET_VERSION,
  Object.entries(QUESTIONS).filter(([, q]) => q.type === "noul").map(([k]) => k),
);

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
    const n = normalizeAnswers(ctx.response.answers, QUESTIONS);
    if (!n.ok) throw new ResponseRejectedError(`invalid_response_${n.code}`);
    persistNormalizedAnswers(ctx, n.answers, spamThresholdFor(ctx.accountId), "pipeline", QUESTION_SET_VERSION);
    // E7: Jev's spam verdicts per sender feed the HITL question. Same transaction as the answers.
    const spam = n.answers.find((a) => a.key === "is_spam");
    if (spam && interpretNoul(spam, QUESTION_SET_VERSION) === "positive") {
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
): ShadowQuarantine {
  const ins = ctx.db.prepare(
    "INSERT INTO classification_answers (classification_id, question_key, type, answer_json, probabilities_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const a of answers) {
    ins.run(ctx.classificationId, a.key, a.type, JSON.stringify({ value: a.value }),
      a.probabilities ? JSON.stringify(a.probabilities) : null);
  }
  const shadow = computeShadowQuarantine(answers, spamThreshold, undefined, questionSetVersion);
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
  response: DecisionsResponse;
  latencyMs: number;
  attempts: number;
  traceId: string;
  now: Date;
}

export interface PipelineOptions {
  db: DatabaseSync;
  clock?: SchedulerClock;
  jev: JevClient;
  /** Creates a read-only IMAP port for a retry refetch. The pipeline connects and closes it. */
  portFactory: (accountId: string) => ImapPort;
  persistResponse?: (ctx: ClassifiedContext) => void;
  /**
   * Called after the classification is committed (ids only). Errors, sync or async, are swallowed: a consumer such as
   * the mailbox rules must never fail or roll back a classification.
   */
  onClassified?: (info: { emailId: number; accountId: string }) => void | Promise<void>;
  accountContext?: (accountId: string) => string | undefined;
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
}

export function createClassificationPipeline(opts: PipelineOptions): ClassificationPipeline {
  const { db, jev } = opts;
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

  function buildRequest(accountId: string, input: TransientInput) {
    const at = input.sender.lastIndexOf("@");
    const ctx = opts.accountContext?.(accountId);
    // T55/H21: two numbers, only for an authenticated sender (DMARC pass) with feedback; otherwise absent.
    const history = feedbackHistory(db, input.sender, input.dmarc);
    return {
      questions: QUESTIONS,
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
    const result = await jev.classify(buildRequest(row.account_id, input));
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
          db, classificationId: row.id, emailId: row.email_id, accountId: row.account_id,
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
      `SELECT c.id, c.email_id, c.attempts, e.account_id FROM classifications c JOIN emails e ON e.id = c.email_id
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
        db.prepare(
          `INSERT OR IGNORE INTO classifications
             (email_id, question_set_version, model_requested, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
        ).run(emailId, QUESTION_SET_VERSION, JEV_MODEL, ts, ts);
        const r = db.prepare(
          "SELECT id, email_id, attempts FROM classifications WHERE email_id = ? AND question_set_version = ? AND model_requested = ?",
        ).get(emailId, QUESTION_SET_VERSION, JEV_MODEL) as unknown as Omit<Row, "account_id">;
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
