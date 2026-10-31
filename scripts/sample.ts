// Manuelles, bestaetigtes Read-only-Sample (T17, D8): letzte N Mails je mailbox/spam_mailbox, Vorschau zuerst.
// Aufruf: npm run sample -- --account <id> --limit-per-folder 200 [--confirm <N>] [--question-set <version>]
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createPersistResponse, createClassificationPipeline } from "../lib/classification-pipeline.ts";
import { JEV_MODEL, PROJECT_ROOT, QUESTION_SET_VERSION, SAMPLE_HARD_LIMIT } from "../lib/constants.ts";
import { checkFolderMapping, createImapFlowPort, formatFolderCheck, parseMessage, type ImapPort } from "../lib/imap.ts";
import { ingestMail } from "../lib/ingest.ts";
import { createJevClient, type JevClient } from "../lib/jev.ts";

export const DEFAULT_LIMIT_PER_FOLDER = 200;

export type SampleErrorCode =
  | "invalid_limit" | "confirm_mismatch" | "limit_exceeded" | "question_set_unknown" | "bad_args" | "folder_not_found";

export class SampleError extends Error {
  readonly code: SampleErrorCode;
  constructor(code: SampleErrorCode, message: string) {
    super(message);
    this.name = "SampleError";
    this.code = code;
  }
}

export interface SampleAccount {
  id: string;
  mailbox: string;
  spam_mailbox?: string | undefined;
  spam_threshold: number;
  context: string;
}

export interface SampleDeps {
  db: DatabaseSync;
  account: SampleAccount;
  /** Read-only IMAP port for selection and fetching (the caller creates it; sample connects and closes it). */
  port: ImapPort;
  /** Port factory for the pipeline's retry refetch. */
  portFactory: (accountId: string) => ImapPort;
  /** Only needed for execution; a preview never calls Jev. */
  jev?: JevClient;
  now?: () => Date;
  /** Aggregated counters only. */
  onProgress?: (p: SampleProgress) => void;
}

export interface SampleOptions {
  limitPerFolder: number;
  confirm?: number | undefined;
  questionSet?: string | undefined;
}

export interface SampleProgress {
  total: number;
  done: number;
  classified: number;
  skipped: number;
  failed: number;
  deferred: number;
  sourceGone: number;
}

export type FolderRole = "mailbox" | "spam_mailbox";

export interface SampleResult {
  mode: "preview" | "run";
  selected: Record<FolderRole, number>;
  total: number;
  overLimit: boolean;
  /** Selected mails that would be skipped as already classified. */
  wouldSkip: number;
  progress?: SampleProgress;
  aborted?: "jev_paused";
  /** Comparison label: folder of the active location (provider verdict) vs. Jev category, counts only. */
  byFolder?: Record<FolderRole | "other", { classified: number; categories: Record<string, number> }>;
}

interface Selected {
  role: FolderRole;
  folder: string;
  uid: number;
  uidValidity: number;
  messageId: string | null;
  seen?: boolean | undefined;
}

export function parseSampleArgs(argv: string[]): {
  account: string; limitPerFolder: number; confirm?: number; questionSet?: string;
} {
  const out: { account?: string; limitPerFolder: number; confirm?: number; questionSet?: string } = {
    limitPerFolder: DEFAULT_LIMIT_PER_FOLDER,
  };
  const int = (v: string | undefined, name: string) => {
    if (v === undefined || !/^\d+$/.test(v)) throw new SampleError("bad_args", `${name} needs a non-negative integer`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--account") { if (!v) throw new SampleError("bad_args", "--account needs a value"); out.account = v; i++; }
    else if (a === "--limit-per-folder") { out.limitPerFolder = int(v, a); i++; }
    else if (a === "--confirm") { out.confirm = int(v, a); i++; }
    else if (a === "--question-set") { if (!v) throw new SampleError("bad_args", "--question-set needs a value"); out.questionSet = v; i++; }
    else throw new SampleError("bad_args", `unknown option ${a}`);
  }
  if (!out.account) throw new SampleError("bad_args", "--account is required");
  return out as { account: string; limitPerFolder: number; confirm?: number; questionSet?: string };
}

function knownEmailId(db: DatabaseSync, accountId: string, s: Selected): number | undefined {
  if (s.messageId !== null) {
    const r = db.prepare("SELECT id FROM emails WHERE account_id = ? AND message_id = ?")
      .get(accountId, s.messageId) as { id: number } | undefined;
    if (r) return r.id;
  }
  const l = db.prepare(
    "SELECT email_id FROM email_locations WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?",
  ).get(accountId, s.folder, s.uidValidity, s.uid) as { email_id: number } | undefined;
  return l?.email_id;
}

function alreadyClassified(db: DatabaseSync, emailId: number, questionSet: string | undefined): boolean {
  // Default: any finished classification counts. With --question-set only that exact question set counts.
  const row = questionSet === undefined
    ? db.prepare("SELECT 1 x FROM classifications WHERE email_id = ? AND status = 'classified' LIMIT 1").get(emailId)
    : db.prepare(
      "SELECT 1 x FROM classifications WHERE email_id = ? AND status = 'classified' AND question_set_version = ? AND model_requested = ? LIMIT 1",
    ).get(emailId, questionSet, JEV_MODEL);
  return row !== undefined;
}

export async function runSample(deps: SampleDeps, opts: SampleOptions): Promise<SampleResult> {
  const { db, account, port } = deps;
  const now = deps.now ?? (() => new Date());
  const traceId = randomUUID();
  if (!Number.isInteger(opts.limitPerFolder) || opts.limitPerFolder < 1) {
    throw new SampleError("invalid_limit", "--limit-per-folder must be a positive integer");
  }
  if (opts.questionSet !== undefined && opts.questionSet !== QUESTION_SET_VERSION) {
    throw new SampleError("question_set_unknown", "unknown question set version");
  }
  const audit = (action: string, details: Record<string, unknown>) =>
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, details_json)
       VALUES (?, ?, 'sample', ?, ?, ?)`,
    ).run(now().toISOString(), traceId, action, account.id, JSON.stringify(details));

  await port.connect();
  const statusByFolder = new Map<string, number>();
  const selection: Selected[] = [];
  const selected: Record<FolderRole, number> = { mailbox: 0, spam_mailbox: 0 };
  try {
    if (port.listFolders) {
      const check = checkFolderMapping(await port.listFolders(), account);
      if (check.missing.length > 0) throw new SampleError("folder_not_found", `\n${formatFolderCheck(check)}`);
    }
    const folders: { role: FolderRole; folder: string }[] = [{ role: "mailbox", folder: account.mailbox }];
    if (account.spam_mailbox !== undefined && account.spam_mailbox !== account.mailbox) {
      folders.push({ role: "spam_mailbox", folder: account.spam_mailbox });
    }
    for (const { role, folder } of folders) {
      const status = await port.mailboxStatus(folder);
      statusByFolder.set(folder, status.uidValidity);
      const headers = (await port.fetchHeadersSince(folder, 0)).sort((a, b) => b.uid - a.uid)
        .slice(0, opts.limitPerFolder);
      selected[role] = headers.length;
      for (const h of headers) {
        selection.push({ role, folder, uid: h.uid, uidValidity: status.uidValidity, messageId: h.messageId, seen: h.seen });
      }
    }
    const total = selection.length;
    const overLimit = total > SAMPLE_HARD_LIMIT;
    const wouldSkip = selection.filter((s) => {
      const id = knownEmailId(db, account.id, s);
      return id !== undefined && alreadyClassified(db, id, opts.questionSet);
    }).length;

    if (opts.confirm === undefined) {
      audit("sample_previewed", { ...selected, total, limit_per_folder: opts.limitPerFolder, over_limit: overLimit, would_skip: wouldSkip });
      return { mode: "preview", selected, total, overLimit, wouldSkip };
    }
    if (overLimit) throw new SampleError("limit_exceeded", `selection of ${total} exceeds the hard limit of ${SAMPLE_HARD_LIMIT}`);
    if (opts.confirm !== total) {
      throw new SampleError("confirm_mismatch", `--confirm ${opts.confirm} does not match the preview count ${total}`);
    }
    if (!deps.jev) throw new SampleError("bad_args", "Jev client missing");

    const pipeline = createClassificationPipeline({
      db,
      jev: deps.jev,
      portFactory: deps.portFactory,
      accountContext: () => account.context,
      persistResponse: createPersistResponse(() => account.spam_threshold),
      ...(deps.now ? { clock: { now: deps.now, setInterval: () => 0, clearInterval: () => {} } } : {}),
    });
    const progress: SampleProgress = { total, done: 0, classified: 0, skipped: 0, failed: 0, deferred: 0, sourceGone: 0 };
    const touched = new Set<number>();
    audit("sample_started", { total, ...selected, question_set: opts.questionSet ?? QUESTION_SET_VERSION });
    let aborted: "jev_paused" | undefined;

    for (const s of selection) {
      const known = knownEmailId(db, account.id, s);
      if (known !== undefined && alreadyClassified(db, known, opts.questionSet)) {
        progress.skipped++;
      } else {
        // Known mails are re-read from their active location, new ones from the selected one.
        let src = { folder: s.folder, uid: s.uid, uidValidity: s.uidValidity };
        if (known !== undefined) {
          const act = db.prepare(
            "SELECT folder, uid, uid_validity FROM email_locations WHERE email_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1",
          ).get(known) as { folder: string; uid: number; uid_validity: number } | undefined;
          if (act) src = { folder: act.folder, uid: act.uid, uidValidity: act.uid_validity };
        }
        try {
          let validity = statusByFolder.get(src.folder);
          if (validity === undefined) {
            validity = (await port.mailboxStatus(src.folder)).uidValidity;
            statusByFolder.set(src.folder, validity);
          }
          const raw = validity === src.uidValidity ? await port.fetchMessageByUid(src.folder, src.uid) : null;
          if (!raw) {
            progress.sourceGone++;
          } else {
            const parsed = await parseMessage(raw.source);
            const { emailId } = ingestMail(db, {
              accountId: account.id, meta: parsed.meta, loc: src, now: now(), traceId, seen: known === undefined ? s.seen : undefined,
            });
            touched.add(emailId);
            await pipeline.submit({ emailId, accountId: account.id, input: { ...parsed.meta, excerpt: parsed.excerpt } });
            const st = (db.prepare(
              "SELECT status FROM classifications WHERE email_id = ? AND question_set_version = ? AND model_requested = ?",
            ).get(emailId, QUESTION_SET_VERSION, JEV_MODEL) as { status: string } | undefined)?.status;
            if (st === "classified") progress.classified++;
            else if (st === "failed") progress.failed++;
            else if (st === "paused") { aborted = "jev_paused"; }
            else progress.deferred++;
          }
        } catch {
          progress.failed++;
        }
      }
      progress.done++;
      deps.onProgress?.({ ...progress });
      if (aborted) break;
    }

    const byFolder: NonNullable<SampleResult["byFolder"]> = {
      mailbox: { classified: 0, categories: {} },
      spam_mailbox: { classified: 0, categories: {} },
      other: { classified: 0, categories: {} },
    };
    for (const id of touched) {
      const r = db.prepare(
        `SELECT l.folder AS folder, a.answer_json AS answer FROM classifications c
         JOIN classification_answers a ON a.classification_id = c.id AND a.question_key = 'category'
         JOIN email_locations l ON l.email_id = c.email_id AND l.is_active = 1
         WHERE c.email_id = ? AND c.status = 'classified' AND c.question_set_version = ? AND c.model_requested = ?
         ORDER BY l.id DESC LIMIT 1`,
      ).get(id, QUESTION_SET_VERSION, JEV_MODEL) as { folder: string; answer: string } | undefined;
      if (!r) continue;
      const role = r.folder === account.mailbox ? "mailbox" : r.folder === account.spam_mailbox ? "spam_mailbox" : "other";
      const value = String((JSON.parse(r.answer) as { value: unknown }).value);
      byFolder[role].classified++;
      byFolder[role].categories[value] = (byFolder[role].categories[value] ?? 0) + 1;
    }
    audit("sample_finished", { ...progress, aborted: aborted ?? null });
    return { mode: "run", selected, total, overLimit, wouldSkip, progress, ...(aborted ? { aborted } : {}), byFolder };
  } finally {
    await port.close().catch(() => {});
  }
}

export function formatSample(r: SampleResult): string {
  const lines = [
    `sample ${r.mode}: mailbox=${r.selected.mailbox} spam_mailbox=${r.selected.spam_mailbox} total=${r.total} would_skip=${r.wouldSkip}`,
  ];
  if (r.mode === "preview") {
    lines.push(r.overLimit
      ? `  over the hard limit of ${SAMPLE_HARD_LIMIT}: lower --limit-per-folder`
      : `  no Jev call made. To run: add --confirm ${r.total}`);
  }
  if (r.progress) {
    const p = r.progress;
    lines.push(`  done=${p.done}/${p.total} classified=${p.classified} skipped=${p.skipped} failed=${p.failed} deferred=${p.deferred} source_gone=${p.sourceGone}`);
  }
  if (r.aborted) lines.push(`  aborted: ${r.aborted}`);
  for (const [k, v] of Object.entries(r.byFolder ?? {})) {
    if (v.classified > 0) lines.push(`  folder ${k}: classified=${v.classified} categories=${JSON.stringify(v.categories)}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { startup } = await import("../lib/accounts.ts");
  let args;
  try {
    args = parseSampleArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : "bad arguments");
    process.exit(2);
  }
  const started = startup({ env: process.env, projectRoot: PROJECT_ROOT });
  try {
    const { loadKeyring } = await import("../lib/account-secrets.ts");
    const { loadWorkerAccounts } = await import("../lib/mail-accounts.ts");
    const keys = loadKeyring(process.env);
    if (!keys.ok) {
      console.error("ACCOUNTS_ENCRYPTION_KEY is not set or invalid");
      process.exit(2);
    }
    const acc = loadWorkerAccounts(started.db, keys.keyring).accounts.find((a) => a.id === args.account);
    if (!acc) {
      console.error("unknown account id");
      process.exit(2);
    }
    const mk = () => createImapFlowPort({ host: acc.host, port: acc.port, tls: acc.tls, user: acc.user, password: acc.password });
    let jev: JevClient | undefined;
    if (args.confirm !== undefined) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.error("OPENROUTER_API_KEY is not set");
        process.exit(2);
      }
      jev = createJevClient({ apiKey, timeoutMs: 60_000 });
    }
    const result = await runSample({
      db: started.db, account: acc, port: mk(), portFactory: () => mk(),
      ...(jev ? { jev } : {}),
      onProgress: (p) => {
        if (p.done % 10 === 0 || p.done === p.total) {
          console.log(`  progress ${p.done}/${p.total} classified=${p.classified} skipped=${p.skipped} failed=${p.failed}`);
        }
      },
    }, { limitPerFolder: args.limitPerFolder, confirm: args.confirm, questionSet: args.questionSet });
    console.log(formatSample(result));
    process.exitCode = result.aborted ? 1 : 0;
  } catch (e) {
    if (e instanceof SampleError) {
      console.error(`${e.code}: ${e.message}`);
    } else {
      // Only class, code and auth flag: messages may contain host or user names (H4).
      const err = e as { name?: unknown; code?: unknown; authenticationFailed?: unknown; serverResponseCode?: unknown };
      const parts = [`name=${String(err?.name ?? "unknown")}`];
      if (typeof err?.code === "string") parts.push(`code=${err.code}`);
      // IMAP response codes are fixed tokens (e.g. AUTHENTICATIONFAILED), no account data.
      if (typeof err?.serverResponseCode === "string" && /^[A-Z0-9-]{1,40}$/.test(err.serverResponseCode)) {
        parts.push(`server=${err.serverResponseCode}`);
      }
      if (err?.authenticationFailed === true) parts.push("auth_failed=true");
      const resp = (e as { responseStatus?: unknown }).responseStatus;
      if (typeof resp === "string" && /^[A-Z]{2,3}$/.test(resp)) parts.push(`status=${resp}`);
      // IMAP command verb only (e.g. EXAMINE), never its arguments.
      const verb = /^\S+\s+([A-Za-z]+)/.exec(String((e as { executedCommand?: unknown }).executedCommand ?? ""))?.[1];
      if (verb) parts.push(`cmd=${verb.toUpperCase()}`);
      // Code locations only (file:line), never messages.
      const frames = String((e as { stack?: unknown })?.stack ?? "").split("\n").slice(1)
        .map((l) => /([\w.-]+\/[\w.-]+\.(?:ts|js|mjs)):(\d+)/.exec(l)).filter((m) => m !== null)
        .slice(0, 3).map((m) => `${m![1]}:${m![2]}`);
      if (frames.length > 0) parts.push(`at=${frames.join(",")}`);
      console.error(`sample failed (${parts.join(" ")})`);
    }
    process.exitCode = e instanceof SampleError ? 2 : 1;
  } finally {
    started.db.close();
  }
}

if (import.meta.main) await main();
