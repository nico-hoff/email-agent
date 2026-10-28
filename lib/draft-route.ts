// POST /api/emails/:id/draft (Plan v4 T42): reply draft on request. Order: session (401), rate limit (429), CSRF (403),
// id (404), synthetic mode (409), then draftReply: gate (H11), IMAP refetch, agent. The draft exists only in the response
// (D17/H12); errors leave as codes, never as provider or server text.
import type { DatabaseSync } from "node:sqlite";
import { loadAccountsConfig } from "./accounts-config.ts";
import { type AuthContext, guardMutation, syntheticFromEnv } from "./auth-runtime.ts";
import { PROJECT_ROOT } from "./constants.ts";
import { parseEmailId } from "./email-status.ts";
import { type DraftAgent, draftReply } from "./draft-reply.ts";
import { createImapFlowPort, type ImapPort } from "./imap.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface DraftRouteDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  /** Read-only IMAP port per account (H2). */
  portFactory(accountId: string): ImapPort;
  agent(): DraftAgent | undefined | Promise<DraftAgent | undefined>;
  now?: () => Date;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS = new Map<string, number>([
  ["email_not_found", 404], ["not_classified", 409], ["source_gone", 409],
  ["fetch_failed", 502], ["agent_failed", 502], ["invalid_output", 502],
]);

export async function handleDraft(request: Request, rawId: unknown, deps: DraftRouteDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const id = parseEmailId(rawId);
  if (id === null) return json({ error: "not_found" }, 404);
  // The synthetic database has no real mailboxes to refetch from.
  if (deps.auth.synthetic) return json({ error: "not_available_in_synthetic" }, 409);

  let db: DatabaseSync | undefined;
  try {
    let agent: DraftAgent | undefined;
    try {
      agent = await deps.agent();
    } catch {
      agent = undefined;
    }
    if (!agent) return json({ error: "agent_unavailable" }, 503);
    db = deps.openDb();
    const result = await draftReply(
      { db, portFactory: deps.portFactory, agent, ...(deps.now ? { now: deps.now } : {}) },
      id,
      request.signal,
    );
    if (result.ok) {
      const d = result.draft;
      return json({ draft: d.draft, language: d.language, tone: d.tone, needs_human_check: d.needs_human_check, reasons: d.reasons });
    }
    if (result.code === "not_eligible") return json({ error: "not_eligible", reasons: result.reasons }, 409);
    return json({ error: result.code }, STATUS.get(result.code) ?? 502);
  } catch {
    // e.g. a port factory for an unknown account: no details (H4)
    return json({ error: "fetch_failed" }, 502);
  } finally {
    db?.close();
  }
}

/**
 * Default wiring: the accounts file is read at request time, only inside the port factory (credentials never reach
 * the handler); an unknown account throws and the handler answers fetch_failed.
 */
export function defaultPortFactory(env: Record<string, string | undefined> = process.env): (accountId: string) => ImapPort {
  return (accountId) => {
    if (syntheticFromEnv(env, PROJECT_ROOT)) throw new Error("synthetic");
    const cfg = loadAccountsConfig({ env, projectRoot: PROJECT_ROOT });
    const acc = cfg.status === "ok" ? cfg.accounts.find((a) => a.id === accountId) : undefined;
    if (!acc) throw new Error("account unavailable");
    return createImapFlowPort({ host: acc.host, port: acc.port, tls: acc.tls, user: acc.user, password: acc.password });
  };
}
