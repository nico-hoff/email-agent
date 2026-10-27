// Write port of the app (Plan v5 H16/H16a, docs/imap-write-contract.md). In M7a it can do exactly two things: set and
// remove the \Seen flag of one message. Nothing destructive exists here (no moving, deleting or storing of messages), and the read port
// (lib/imap.ts) stays strictly read-only. Only lib/mailbox-actions.ts may create this port (a test enforces it).
import { ImapFlow } from "imapflow";
import type { ImapConnectionConfig } from "./imap.ts";

export type ImapWriteFailureCode =
  | "imap_auth"
  | "imap_error"
  | "invalid_target"
  | "uidvalidity_changed"
  | "store_rejected"
  | "message_gone"
  | "store_unverified";

/** The only error this module throws. Carries a code and nothing else: no server text, host, user or UID (H4). */
export class ImapWriteError extends Error {
  readonly code: ImapWriteFailureCode;
  constructor(code: ImapWriteFailureCode) {
    super(code);
    this.name = "ImapWriteError";
    this.code = code;
  }
}

export interface ImapWritePort {
  /** Sets \Seen on one message. Throws ImapWriteError; resolves only when the server confirmed the flag. */
  addSeen(folder: string, uidValidity: number, uid: number): Promise<void>;
  /** Removes \Seen from one message. Throws ImapWriteError; resolves only when the flag is confirmed gone. */
  removeSeen(folder: string, uidValidity: number, uid: number): Promise<void>;
}

type WriteClient = Pick<
  ImapFlow,
  "connect" | "logout" | "close" | "getMailboxLock" | "messageFlagsAdd" | "messageFlagsRemove" | "fetchOne" | "on"
> & { mailbox: ImapFlow["mailbox"] };

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
  return {
    addSeen: (folder, uidValidity, uid) => setSeen(folder, uidValidity, uid, true),
    removeSeen: (folder, uidValidity, uid) => setSeen(folder, uidValidity, uid, false),
  };
}
