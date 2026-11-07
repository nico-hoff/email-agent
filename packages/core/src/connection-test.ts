// "Verbindung testen" (R2): opens the mailbox read-only through the same read-only port the worker uses and only runs
// LIST (no folder is selected, nothing is fetched, nothing is written). The result is a short error class, never a server
// response. The connector is injectable; tests use a fake and never touch the network.
import { checkFolderMapping, type FolderInfo, createImapFlowPort, type ImapConnectionConfig, type ImapPort } from "./imap.ts";

export const TEST_CODES = ["ok", "auth_failed", "tls_failed", "host_unreachable", "timeout", "mailbox_missing", "connect_failed"] as const;
export type TestCode = (typeof TEST_CODES)[number];

export type TestPort = Pick<ImapPort, "connect" | "close" | "on"> & { listFolders: NonNullable<ImapPort["listFolders"]> };
export type TestConnector = (cfg: ImapConnectionConfig) => TestPort;

export const TEST_TIMEOUT_MS = 15_000;
export const defaultConnector: TestConnector = (cfg) => createImapFlowPort(cfg) as TestPort;

const UNREACHABLE = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN"]);
const TLS_CODES = new Set([
  "EPROTO", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "HOSTNAME_MISMATCH", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function classifyError(err: unknown): TestCode {
  const e = (typeof err === "object" && err !== null ? err : {}) as { authenticationFailed?: unknown; code?: unknown };
  if (e.authenticationFailed === true) return "auth_failed";
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "ESOCKETTIMEDOUT" || code === "TEST_TIMEOUT") return "timeout";
  if (UNREACHABLE.has(code)) return "host_unreachable";
  if (TLS_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("ERR_OSSL")) return "tls_failed";
  return "connect_failed";
}

export interface TestTarget extends ImapConnectionConfig {
  mailbox: string;
  spam_mailbox: string | null;
}

/** Names providers use for the spam folder, tried in this order when the server marks none with the special-use flag \\Junk. */
export const SPAM_FOLDER_NAMES: readonly string[] = ["Junk", "Spam", "Junk E-Mail", "Junk Email", "INBOX.Junk", "INBOX.Spam", "Bulk Mail", "[Gmail]/Spam"];

/** The spam folder of a LIST result: the folder the server flags \\Junk, else the first well-known name; null when none. */
export function detectSpamFolder(list: FolderInfo[]): string | null {
  const flagged = list.find((f) => f.specialUse === "\\Junk");
  if (flagged) return flagged.path;
  for (const name of SPAM_FOLDER_NAMES) {
    const hit = list.find((f) => f.path === name);
    if (hit) return hit.path;
  }
  return null;
}

export interface TestOutcome { code: TestCode; /** Only when the account has no spam folder yet and one was found. */ spamMailbox: string | null }

export async function testConnection(target: TestTarget, connector: TestConnector = defaultConnector, timeoutMs: number = TEST_TIMEOUT_MS): Promise<TestCode> {
  return (await testConnectionDetailed(target, connector, timeoutMs)).code;
}

export async function testConnectionDetailed(target: TestTarget, connector: TestConnector = defaultConnector, timeoutMs: number = TEST_TIMEOUT_MS): Promise<TestOutcome> {
  const { mailbox, spam_mailbox, ...cfg } = target;
  let port: TestPort;
  try {
    port = connector(cfg);
  } catch (e) {
    return { code: classifyError(e), spamMailbox: null };
  }
  // Without listeners an ImapFlow socket error would be an unhandled 'error' event.
  port.on("error", () => {});
  port.on("close", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TEST_TIMEOUT" })), timeoutMs);
  });
  try {
    const run = (async (): Promise<TestOutcome> => {
      await port.connect();
      const list = await port.listFolders();
      const check = checkFolderMapping(list, { mailbox, spam_mailbox: spam_mailbox ?? undefined });
      if (check.missing.length > 0) return { code: "mailbox_missing", spamMailbox: null };
      return { code: "ok", spamMailbox: spam_mailbox === null ? detectSpamFolder(list) : null };
    })();
    run.catch(() => {}); // a late rejection after the deadline must not be unhandled
    return await Promise.race([run, deadline]);
  } catch (e) {
    return { code: classifyError(e), spamMailbox: null };
  } finally {
    clearTimeout(timer);
    try {
      await port.close();
    } catch {
      // already closed
    }
  }
}
