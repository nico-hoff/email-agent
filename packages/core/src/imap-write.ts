// Write port of the app (Plan v5 H16/H16a, ADR 0025/0038, docs/imap-write-contract.md). It can do exactly three things: set and
// remove the \Seen flag of one message, and move one message between INBOX, the folder "Quarantäne" and the provider's trash
// (a real IMAP MOVE only). Nothing destructive exists here: no deleting, no flag other than \Seen, no copying, no appending.
// The read port (packages/core/src/imap.ts) stays strictly read-only. Only packages/core/src/mailbox-actions.ts may create this port (a test enforces it).
import { ImapFlow } from "imapflow";
import type { ImapConnectionConfig } from "./imap.ts";

export type ImapWriteFailureCode =
  | "imap_auth"
  | "imap_error"
  | "invalid_target"
  | "uidvalidity_changed"
  | "store_rejected"
  | "message_gone"
  | "store_unverified"
  | "move_unsupported"
  | "move_rejected"
  | "move_unverified"
  | "trash_not_found"
  | "folder_create_failed";

/** The only error this module throws. Carries a code and nothing else: no server text, host, user or UID (H4). */
export class ImapWriteError extends Error {
  readonly code: ImapWriteFailureCode;
  constructor(code: ImapWriteFailureCode) {
    super(code);
    this.name = "ImapWriteError";
    this.code = code;
  }
}

/** Name of the quarantine folder (ADR 0025). Created on demand, and only on the write path. */
export const QUARANTINE_FOLDER = "Quarantäne";

/** Where a message goes. `inbox` is the account's own mailbox (`inboxFolder`). */
export type MoveTarget = "quarantine" | "trash" | "inbox";

export interface MoveRequest {
  folder: string;
  uidValidity: number;
  uid: number;
  target: MoveTarget;
  /** The account's INBOX path; required for target `inbox`. */
  inboxFolder?: string;
}

/** New location of a moved message. `uidValidity` and `uid` are present only when the server reported COPYUID (UIDPLUS). */
export interface MoveResult {
  folder: string;
  uidValidity?: number;
  uid?: number;
}

export interface ImapWritePort {
  /** Sets \Seen on one message. Throws ImapWriteError; resolves only when the server confirmed the flag. */
  addSeen(folder: string, uidValidity: number, uid: number): Promise<void>;
  /** Removes \Seen from one message. Throws ImapWriteError; resolves only when the flag is confirmed gone. */
  removeSeen(folder: string, uidValidity: number, uid: number): Promise<void>;
  /**
   * Moves one message with a native IMAP MOVE. Without the MOVE capability it fails with `move_unsupported` and touches
   * nothing: the copy-and-remove emulation of imapflow is forbidden (ADR 0025). Resolves only when the server confirmed
   * the move and the message is gone from the source (and present in the target when the server reported COPYUID).
   */
  moveMessage(req: MoveRequest): Promise<MoveResult>;
}

type WriteClient = Pick<
  ImapFlow,
  "connect" | "logout" | "close" | "getMailboxLock" | "messageFlagsAdd" | "messageFlagsRemove" | "fetchOne" | "on" |
  "list" | "mailboxCreate" | "messageMove"
> & { mailbox: ImapFlow["mailbox"]; capabilities: ImapFlow["capabilities"]; namespace: ImapFlow["namespace"] };

/** Fallback names when the server reports no \Trash special use (compared case-insensitively against the folder's own name). */
export const TRASH_FALLBACK_NAMES: readonly string[] = [
  "Trash", "Papierkorb", "Deleted Items", "Deleted Messages", "Gelöschte Elemente", "Gelöschte Objekte", "Gelöschte Nachrichten",
];

interface ListedFolder { path: string; name: string; specialUse?: string | undefined; specialUseSource?: string | undefined }

/** Provider trash: special use \Trash from the server first, then the fallback names. undefined = none found (never guess further). */
export function findTrashFolder(list: readonly ListedFolder[]): string | undefined {
  const flagged = list.find((f) => f.specialUse === "\\Trash" && f.specialUseSource === "extension") ?? list.find((f) => f.specialUse === "\\Trash");
  if (flagged) return flagged.path;
  const lower = TRASH_FALLBACK_NAMES.map((n) => n.toLowerCase());
  return list.find((f) => lower.includes(f.name.toLowerCase()))?.path;
}

const SOCKET_TIMEOUT_MS = 60_000;
const SEEN = "\\Seen";

function defaultFactory(cfg: ImapConnectionConfig): WriteClient {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

function hasSeen(flags: Set<string> | undefined): boolean {
  if (!flags) return false;
  for (const f of flags) if (f.toLowerCase() === "\\seen") return true;
  return false;
}

function isAuthError(e: unknown): boolean {
  return (e as { authenticationFailed?: boolean } | null)?.authenticationFailed === true;
}

/**
 * Every call uses its own short-lived connection, so the IDLE/read connection of the worker is never touched
 * (contract section 3). Order: connect, writable lock, UIDVALIDITY comparison (imapflow does not check it), STORE by
 * UID, read the flags back. A `false` from messageFlagsAdd/Remove is imapflow's silent NO/BAD and becomes store_rejected.
 */
export function createImapWritePort(
  cfg: ImapConnectionConfig,
  factory: (cfg: ImapConnectionConfig) => WriteClient = defaultFactory,
): ImapWritePort {
  async function setSeen(folder: string, uidValidity: number, uid: number, seen: boolean): Promise<void> {
    if (
      typeof folder !== "string" || folder === "" ||
      !Number.isSafeInteger(uidValidity) || uidValidity < 1 ||
      !Number.isSafeInteger(uid) || uid < 1
    ) throw new ImapWriteError("invalid_target");
    const client = factory(cfg);
    client.on("error", () => {}); // an unhandled 'error' event would crash the process; failures surface through the calls
    try {
      try {
        await client.connect();
      } catch (e) {
        throw new ImapWriteError(isAuthError(e) ? "imap_auth" : "imap_error");
      }
      let lock: { release(): void };
      try {
        lock = await client.getMailboxLock(folder, { readOnly: false });
      } catch {
        throw new ImapWriteError("imap_error");
      }
      try {
        const mb = client.mailbox;
        if (!mb || Number(mb.uidValidity) !== uidValidity) throw new ImapWriteError("uidvalidity_changed");
        const ok = seen
          ? await client.messageFlagsAdd([uid], [SEEN], { uid: true })
          : await client.messageFlagsRemove([uid], [SEEN], { uid: true });
        if (ok !== true) throw new ImapWriteError("store_rejected");
        const after = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
        if (!after) throw new ImapWriteError("message_gone");
        if (hasSeen(after.flags) !== seen) throw new ImapWriteError("store_unverified");
      } catch (e) {
        throw e instanceof ImapWriteError ? e : new ImapWriteError("imap_error");
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  async function moveOne(req: MoveRequest): Promise<MoveResult> {
    const { folder, uidValidity, uid, target } = req;
    if (
      typeof folder !== "string" || folder === "" ||
      !Number.isSafeInteger(uidValidity) || uidValidity < 1 ||
      !Number.isSafeInteger(uid) || uid < 1 ||
      (target === "inbox" && (typeof req.inboxFolder !== "string" || req.inboxFolder === ""))
    ) throw new ImapWriteError("invalid_target");
    const client = factory(cfg);
    client.on("error", () => {});
    try {
      try {
        await client.connect();
      } catch (e) {
        throw new ImapWriteError(isAuthError(e) ? "imap_auth" : "imap_error");
      }
      // imapflow would emulate a missing MOVE with a copy and a permanent removal. That is forbidden: stop before anything is touched.
      if (!client.capabilities.has("MOVE")) throw new ImapWriteError("move_unsupported");

      const destination = await resolveTarget(client, req);
      if (destination === folder) throw new ImapWriteError("invalid_target");

      let moved: { destination: string; uidValidity?: bigint | undefined; uidMap?: Map<number, number> | undefined };
      let lock: { release(): void };
      try {
        lock = await client.getMailboxLock(folder, { readOnly: false });
      } catch {
        throw new ImapWriteError("imap_error");
      }
      try {
        const mb = client.mailbox;
        if (!mb || Number(mb.uidValidity) !== uidValidity) throw new ImapWriteError("uidvalidity_changed");
        const before = await client.fetchOne(String(uid), { uid: true }, { uid: true });
        if (!before) throw new ImapWriteError("message_gone");
        const res = await client.messageMove([uid], destination, { uid: true });
        if (!res) throw new ImapWriteError("move_rejected");
        moved = res;
        const after = await client.fetchOne(String(uid), { uid: true }, { uid: true });
        if (after) throw new ImapWriteError("move_unverified"); // still in the source: the move did not happen
      } catch (e) {
        throw e instanceof ImapWriteError ? e : new ImapWriteError("imap_error");
      } finally {
        lock.release();
      }

      const newUid = moved.uidMap?.get(uid);
      if (moved.uidValidity === undefined || newUid === undefined) return { folder: destination };
      const newValidity = Number(moved.uidValidity);
      // Present in the target? (read-only look at the new UID)
      try {
        const tl = await client.getMailboxLock(destination, { readOnly: true });
        try {
          if (Number(client.mailbox ? client.mailbox.uidValidity : 0) !== newValidity) throw new ImapWriteError("move_unverified");
          const there = await client.fetchOne(String(newUid), { uid: true }, { uid: true });
          if (!there) throw new ImapWriteError("move_unverified");
        } finally {
          tl.release();
        }
      } catch (e) {
        throw e instanceof ImapWriteError ? e : new ImapWriteError("imap_error");
      }
      return { folder: destination, uidValidity: newValidity, uid: newUid };
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  /** Target path. Only `quarantine` may create a folder (write path only); trash is never created; inbox is the account's own. */
  async function resolveTarget(client: WriteClient, req: MoveRequest): Promise<string> {
    if (req.target === "inbox") return req.inboxFolder ?? "INBOX";
    let list: ListedFolder[];
    try {
      list = await client.list();
    } catch {
      throw new ImapWriteError("imap_error");
    }
    if (req.target === "trash") {
      const trash = findTrashFolder(list);
      if (trash === undefined) throw new ImapWriteError("trash_not_found");
      return trash;
    }
    // The server's own delimiter and namespace decide the path: imapflow adds the personal namespace prefix to a plain name.
    const prefix = client.namespace?.prefix ?? "";
    const wanted = prefix + QUARANTINE_FOLDER;
    const found = list.find((f) => f.path === wanted) ?? list.find((f) => f.name === QUARANTINE_FOLDER && f.path.length <= wanted.length);
    if (found) return found.path;
    try {
      const created = await client.mailboxCreate(QUARANTINE_FOLDER);
      return created.path;
    } catch {
      throw new ImapWriteError("folder_create_failed");
    }
  }

  return {
    moveMessage: moveOne,
    addSeen: (folder, uidValidity, uid) => setSeen(folder, uidValidity, uid, true),
    removeSeen: (folder, uidValidity, uid) => setSeen(folder, uidValidity, uid, false),
  };
}
