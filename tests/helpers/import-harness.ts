// Shared by the initial-import tests and the screenshot simulation: a fake clock, a fake IMAP port with a synthetic INBOX
// and a fake classifier hand-over (onIngested) that writes the same rows the real pipeline writes. Synthetic content only.
import type { DatabaseSync } from "node:sqlite";
import { syncAccounts } from "../../packages/core/src/accounts.ts";
import { openDatabase } from "../../packages/core/src/db.ts";
import type { ImapEventError, ImapPort, TransientInput } from "../../packages/core/src/imap.ts";
import { createImapWorkers } from "../../workers/imap-worker.ts";

export const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

export class FakeClock {
  t = Date.parse("2026-10-31T12:00:00.000Z");
  timers: { at: number; fn: () => void; id: number }[] = [];
  nextId = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

export class ImportPort implements ImapPort {
  handlers: Record<string, (...a: never[]) => void> = {};
  inbox: number[] = [];
  /** UIDs the fake server holds that are older than the window (SEARCH SINCE leaves them out). */
  old = new Set<number>();
  seen = new Set<number>();
  searchCalls: { folder: string; since: Date; maxUid: number }[] = [];
  fetched: number[] = [];
  failFetchAt: number | null = null;
  connectImpl: () => Promise<void> = async () => {};
  readonly writes: string[] = [];
  connect() { return this.connectImpl(); }
  async mailboxStatus() { return { uidValidity: 1, highestUid: Math.max(0, ...this.inbox) }; }
  async fetchHeadersSince(_f: string, after: number) {
    return this.inbox.filter((u) => u > after).map((uid) => ({ uid, messageId: `<${uid}@x.test>`, seen: this.seen.has(uid) }));
  }
  async fetchFlags(_f: string, uids: number[]) { return uids.map((uid) => ({ uid, seen: this.seen.has(uid) })); }
  async searchUids(folder: string, o: { since: Date; maxUid: number }) {
    this.searchCalls.push({ folder, ...o });
    return this.inbox.filter((u) => u <= o.maxUid && !this.old.has(u));
  }
  async fetchMessageByUid(_f: string, uid: number) {
    if (this.failFetchAt === uid) { this.failFetchAt = null; throw new Error("net"); }
    this.fetched.push(uid);
    const src = `Message-ID: <${uid}@x.test>\r\nFrom: Absender ${uid % 7} <a${uid % 7}@example.test>\r\nSubject: Testmail ${uid}\r\nDate: Fri, 30 Oct 2026 10:00:00 +0000\r\n\r\nSYNTHETIC BODY ${uid}`;
    return { uid, source: Buffer.from(src) };
  }
  async watch() {}
  on(ev: string, cb: (...a: never[]) => void) { this.handlers[ev] = cb; }
  emit(ev: string, arg?: unknown) { (this.handlers[ev] as (a?: unknown) => void)?.(arg); }
  async close() {}
}

export const account = (id: string) => ({
  id, label: id, context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
  mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true,
}) as never;

/** Writes what the pipeline writes for a finished classification (status + a few answers), without any model. */
export function fakeClassify(db: DatabaseSync, emailId: number, ts: string, over: { status?: "classified" | "failed"; category?: string } = {}): void {
  const status = over.status ?? "classified";
  db.prepare(
    `INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, failure_code, attempts, created_at, updated_at)
     VALUES (?, 'email-classification-v2', 'typesafe/jev-1.13', ?, ?, ?, 1, ?, ?)
     ON CONFLICT (email_id, question_set_version, model_requested) DO UPDATE SET status = excluded.status,
       model_reported = excluded.model_reported, failure_code = excluded.failure_code, updated_at = excluded.updated_at`,
  ).run(emailId, status === "classified" ? "typesafe/jev-1.13" : null, status, status === "failed" ? "max_attempts" : null, ts, ts);
  if (status !== "classified") return;
  const c = db.prepare("SELECT id FROM classifications WHERE email_id = ? ORDER BY id DESC LIMIT 1").get(emailId) as { id: number };
  const ins = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?, ?, ?, ?)");
  ins.run(c.id, "category", "choice", JSON.stringify({ value: over.category ?? (emailId % 5 === 0 ? "spam" : emailId % 3 === 0 ? "newsletter_promo" : "personal") }));
  ins.run(c.id, "route", "choice", JSON.stringify({ value: "read" }));
  ins.run(c.id, "urgency", "score", JSON.stringify({ value: 0.3 }));
  ins.run(c.id, "importance", "score", JSON.stringify({ value: emailId % 4 === 0 ? 0.9 : 0.4 }));
}

export interface ImportHarness {
  db: DatabaseSync;
  clock: FakeClock;
  port: ImportPort;
  ports: ImportPort[];
  workers: ReturnType<typeof createImapWorkers>;
  ingested: number[];
  inputs: TransientInput[];
}

export interface HarnessOptions {
  db?: DatabaseSync;
  port?: ImportPort;
  id?: string;
  /** Delay per fake classification, in fake-clock ms (0 = immediately). */
  classifyMs?: number;
  noClassifier?: boolean;
  initialImport?: false | { count?: number; windowDays?: number };
  /** Extra setup for every new port. */
  onPort?: (p: ImportPort, n: number) => void;
  skipSync?: boolean;
}

export function importHarness(o: HarnessOptions = {}): ImportHarness {
  const db = o.db ?? openDatabase(":memory:");
  const id = o.id ?? "a";
  if (!o.skipSync) syncAccounts(db, [account(id)]);
  const clock = new FakeClock();
  const ports: ImportPort[] = [];
  const port = o.port ?? new ImportPort();
  const ingested: number[] = [];
  const inputs: TransientInput[] = [];
  const workers = createImapWorkers({
    db, accounts: [account(id)],
    createPort: () => { ports.push(port); o.onPort?.(port, ports.length); return port; },
    ...(o.noClassifier ? {} : {
      onIngested: async (emailId: number, input: TransientInput) => {
        ingested.push(emailId);
        inputs.push(input);
        const ms = o.classifyMs ?? 0;
        if (ms > 0) await new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
        fakeClassify(db, emailId, new Date(clock.now()).toISOString());
      },
    }),
    ...(o.initialImport !== undefined ? { initialImport: o.initialImport } : {}),
    clock, random: () => 1,
  });
  return { db, clock, port, ports, workers, ingested, inputs };
}
export type { ImapEventError };

/** Advances the fake clock in small steps and yields to real time (mail parsing is asynchronous) until `cond` holds. */
export async function until(h: { clock: FakeClock }, cond: () => boolean, stepMs = 500, maxSteps = 600): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
    await h.clock.advance(stepMs);
  }
  if (!cond()) throw new Error("until: condition not reached");
}
