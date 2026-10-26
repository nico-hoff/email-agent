import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { DatabaseSync } from "node:sqlite";
import { EXCERPT_MAX_CHARS } from "./constants.ts";

export type AuthResult =
  | "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "unknown";
const AUTH_VALUES: ReadonlySet<string> = new Set([
  "pass", "fail", "softfail", "neutral", "none", "temperror", "permerror",
]);

/** Metadata that may be persisted. Contains no body or excerpt. */
export interface MessageMeta {
  messageId: string | null;
  sender: string;
  subject: string;
  receivedAt: string;
  spf: AuthResult;
  dkim: AuthResult;
  dmarc: AuthResult;
  listUnsubscribePresent: boolean;
  replyToDiffersFromFrom: boolean;
}

/** In-memory only; handed to the classifier, never persisted. */
export interface TransientInput extends MessageMeta {
  excerpt: string;
}

export interface MailboxStatus {
  uidValidity: number;
  highestUid: number;
}
export interface HeaderInfo {
  uid: number;
  messageId: string | null;
}
export interface RawMessage {
  uid: number;
  source: Buffer;
}
export interface ImapEventError {
  code: "imap_auth" | "imap_error";
}

/** Read-only IMAP port: deliberately has no write methods. */
export interface FolderInfo {
  path: string;
  specialUse?: string | undefined;
}

/** Folder roles the app knows; the accounts file maps each role to the provider's folder path. */
export type FolderRoleName = "mailbox" | "spam_mailbox";

export interface FolderCheck {
  /** Roles whose configured path does not exist on the server (exact match, as IMAP requires). */
  missing: { role: FolderRoleName; configured: string }[];
  /** Server folders, with special-use flag, to help fix the mapping. */
  available: FolderInfo[];
}

/** Pure check of the configured folder mapping against a LIST result. No guessing, no substitution. */
export function checkFolderMapping(
  list: FolderInfo[],
  mapping: { mailbox: string; spam_mailbox?: string | undefined },
): FolderCheck {
  const paths = new Set(list.map((f) => f.path));
  const missing: FolderCheck["missing"] = [];
  if (!paths.has(mapping.mailbox)) missing.push({ role: "mailbox", configured: mapping.mailbox });
  if (mapping.spam_mailbox !== undefined && !paths.has(mapping.spam_mailbox)) {
    missing.push({ role: "spam_mailbox", configured: mapping.spam_mailbox });
  }
  return { missing, available: list };
}

export function formatFolderCheck(c: FolderCheck): string {
  const hint = (f: FolderInfo) =>
    f.specialUse === "\\Junk" ? "  <- server marks this as spam (\\Junk)"
    : f.specialUse === "\\Inbox" ? "  <- inbox" : "";
  return [
    ...c.missing.map((m) => `folder for ${m.role} not found on server: "${m.configured}"`),
    "available folders (use the exact name in data/accounts.json):",
    ...c.available.map((f) => `  "${f.path}"${hint(f)}`),
  ].join("\n");
}

export interface ImapPort {
  connect(): Promise<void>;
  mailboxStatus(folder: string): Promise<MailboxStatus>;
  /** Header-only fetch of messages with UID greater than `afterUid`. */
  fetchHeadersSince(folder: string, afterUid: number): Promise<HeaderInfo[]>;
  fetchMessageByUid(folder: string, uid: number): Promise<RawMessage | null>;
  /** Selects the folder read-only so that the connection IDLEs on it (call again after polling other folders). */
  watch(folder: string): Promise<void>;
  /** Read-only IMAP LIST: folder paths plus special-use flag (e.g. "\\Junk"). Optional for fakes. */
  listFolders?(): Promise<FolderInfo[]>;
  on(event: "exists", cb: () => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (e: ImapEventError) => void): void;
  close(): Promise<void>;
}

function authResult(header: string, mech: string): AuthResult {
  const m = new RegExp(`(?:^|[\\s;])${mech}\\s*=\\s*([a-z]+)`, "i").exec(header);
  const v = m?.[1]?.toLowerCase();
  return v !== undefined && AUTH_VALUES.has(v) ? (v as AuthResult) : "unknown";
}

function headerText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(headerText).join("; ");
  return "";
}

export async function parseMessage(source: Buffer | string): Promise<{ meta: MessageMeta; excerpt: string }> {
  const p = await simpleParser(source);
  const auth = headerText(p.headers.get("authentication-results"));
  const from = p.from?.value[0]?.address?.toLowerCase() ?? "";
  const replyTo = p.replyTo?.value[0]?.address?.toLowerCase();
  const date = p.date instanceof Date && !Number.isNaN(p.date.getTime()) ? p.date : new Date();
  return {
    meta: {
      messageId: p.messageId ?? null,
      sender: from,
      subject: p.subject ?? "",
      receivedAt: date.toISOString(),
      spf: authResult(auth, "spf"),
      dkim: authResult(auth, "dkim"),
      dmarc: authResult(auth, "dmarc"),
      listUnsubscribePresent: p.headerLines.some((l) => l.key === "list-unsubscribe"),
      replyToDiffersFromFrom: replyTo !== undefined && replyTo !== from,
    },
    excerpt: (p.text ?? "").slice(0, EXCERPT_MAX_CHARS),
  };
}

// ---- ImapFlow adapter -------------------------------------------------------

export interface ImapConnectionConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 10 * 60 * 1000;

type FlowClient = Pick<ImapFlow, "connect" | "logout" | "close" | "getMailboxLock" | "fetch" | "fetchOne" | "on" | "list"> & {
  mailbox: ImapFlow["mailbox"];
};

function defaultFactory(cfg: ImapConnectionConfig): FlowClient {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

function parseMessageId(headers: Buffer | undefined): string | null {
  if (!headers) return null;
  const m = /^message-id:[ \t]*(\S[^\r\n]*)/im.exec(headers.toString("latin1"));
  return m ? m[1].trim() : null;
}

export function createImapFlowPort(
  cfg: ImapConnectionConfig,
  factory: (cfg: ImapConnectionConfig) => FlowClient = defaultFactory,
): ImapPort {
  const client = factory(cfg);
  // Every mailbox access is read-only (EXAMINE); no write method is ever referenced here.
  async function withLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
  return {
    async connect() {
      await client.connect();
    },
    mailboxStatus: (folder) =>
      withLock(folder, async () => {
        const mb = client.mailbox;
        if (!mb) throw new Error("mailbox not open");
        return { uidValidity: Number(mb.uidValidity), highestUid: Math.max(0, mb.uidNext - 1) };
      }),
    fetchHeadersSince: (folder, afterUid) =>
      withLock(folder, async () => {
        const out: HeaderInfo[] = [];
        for await (
          const m of client.fetch(`${afterUid + 1}:*`, { uid: true, headers: ["message-id"] }, { uid: true })
        ) {
          if (m.uid > afterUid) out.push({ uid: m.uid, messageId: parseMessageId(m.headers) });
        }
        return out;
      }),
    fetchMessageByUid: (folder, uid) =>
      withLock(folder, async () => {
        const m = await client.fetchOne(
          String(uid),
          { uid: true, source: { maxLength: MAX_SOURCE_BYTES } },
          { uid: true },
        );
        return m && m.source ? { uid: m.uid, source: m.source } : null;
      }),
    async listFolders() {
      // LIST is a read-only command; no mailbox is selected or changed.
      const list = await client.list();
      return list.map((f) => ({ path: f.path, specialUse: f.specialUse }));
    },
    async watch(folder) {
      // Selects the folder read-only and releases the lock; ImapFlow auto-IDLEs on the selected
      // mailbox (autoIdle is on by default). We never hold the lock, so later fetches are not blocked.
      await withLock(folder, async () => {});
    },
    on(event: string, cb: (...a: never[]) => void) {
      if (event === "error") {
        client.on("error", (err: { authenticationFailed?: boolean }) =>
          (cb as (e: ImapEventError) => void)({
            code: err?.authenticationFailed ? "imap_auth" : "imap_error",
          }));
      } else {
        client.on(event, () => (cb as () => void)());
      }
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  } as ImapPort;
}

// ---- Checkpoints ------------------------------------------------------------

export type CheckpointKind = "baseline" | "continue" | "uidvalidity_reset";
export interface CheckpointOpts {
  now: Date;
  traceId: string;
}

/**
 * First contact: baseline = highest present UID (import nothing).
 * UIDVALIDITY change: new baseline, previous locations of this folder deactivated, audit entry.
 */
export function reconcileCheckpoint(
  db: DatabaseSync,
  accountId: string,
  folder: string,
  status: MailboxStatus,
  opts: CheckpointOpts,
): { kind: CheckpointKind; fromUid: number } {
  const ts = opts.now.toISOString();
  const row = db
    .prepare("SELECT uid_validity, last_uid FROM mailbox_state WHERE account_id = ? AND mailbox = ?")
    .get(accountId, folder) as { uid_validity: number; last_uid: number } | undefined;
  const setBaseline = () =>
    db.prepare(
      `INSERT INTO mailbox_state (account_id, mailbox, uid_validity, last_uid, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid, updated_at = excluded.updated_at`,
    ).run(accountId, folder, status.uidValidity, status.highestUid, ts);
  if (!row) {
    setBaseline();
    return { kind: "baseline", fromUid: status.highestUid };
  }
  if (row.uid_validity !== status.uidValidity) {
    db.exec("BEGIN");
    try {
      setBaseline();
      db.prepare("UPDATE email_locations SET is_active = 0 WHERE account_id = ? AND folder = ?").run(
        accountId,
        folder,
      );
      db.prepare(
        `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, details_json)
         VALUES (?, ?, 'worker', 'uidvalidity_reset', ?, ?)`,
      ).run(ts, opts.traceId, accountId, JSON.stringify({ folder }));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { kind: "uidvalidity_reset", fromUid: status.highestUid };
  }
  return { kind: "continue", fromUid: row.last_uid };
}

export function advanceCheckpoint(
  db: DatabaseSync,
  accountId: string,
  folder: string,
  lastUid: number,
  now: Date,
): void {
  db.prepare(
    "UPDATE mailbox_state SET last_uid = ?, updated_at = ? WHERE account_id = ? AND mailbox = ? AND last_uid < ?",
  ).run(lastUid, now.toISOString(), accountId, folder, lastUid);
}

export interface FetchNewOptions {
  accountId: string;
  folder: string;
  now: Date;
  traceId: string;
  /** Receives metadata only (never the excerpt); returns the email id. */
  writeMetadata(meta: MessageMeta, loc: { folder: string; uid: number; uidValidity: number }): number;
  /** Receives the transient input (with excerpt) in memory only. */
  onIngested(emailId: number, input: TransientInput): void | Promise<void>;
}

/** Reads new messages above the checkpoint, one at a time, advancing the checkpoint after each. */
export async function fetchNewMessages(
  port: ImapPort,
  db: DatabaseSync,
  o: FetchNewOptions,
): Promise<{ kind: CheckpointKind; count: number }> {
  const status = await port.mailboxStatus(o.folder);
  const cp = reconcileCheckpoint(db, o.accountId, o.folder, status, { now: o.now, traceId: o.traceId });
  if (cp.kind !== "continue") return { kind: cp.kind, count: 0 };
  const headers = await port.fetchHeadersSince(o.folder, cp.fromUid);
  let count = 0;
  for (const h of headers.sort((a, b) => a.uid - b.uid)) {
    const raw = await port.fetchMessageByUid(o.folder, h.uid);
    if (raw) {
      const { meta, excerpt } = await parseMessage(raw.source);
      const emailId = o.writeMetadata(meta, { folder: o.folder, uid: h.uid, uidValidity: status.uidValidity });
      await o.onIngested(emailId, { ...meta, excerpt });
      count++;
    }
    advanceCheckpoint(db, o.accountId, o.folder, h.uid, o.now);
  }
  return { kind: "continue", count };
}
