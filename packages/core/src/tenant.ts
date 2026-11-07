// Tenant scope (ADR 0033). Every table owned by a user reaches `accounts.user_id` through its FK chain; every query of
// the app side filters by it. These helpers are the only place that spells the ownership joins out for ids from outside.
// A foreign id must look exactly like a missing one (404), so callers treat `false`/`null` as "not found".
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/** Worker-side lookups: the user an account belongs to. Throws for an unknown account (a worker never invents one). */
export function accountUserId(db: DatabaseSync, accountId: string): number {
  const r = db.prepare("SELECT user_id FROM accounts WHERE id = ?").get(accountId) as { user_id: number } | undefined;
  if (!r) throw new Error("unknown account");
  return r.user_id;
}

/** The user a mail belongs to (through its account), or null for an unknown mail. */
export function emailUserId(db: DatabaseSync, emailId: number): number | null {
  const r = db.prepare("SELECT a.user_id FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ?").get(emailId) as
    | { user_id: number }
    | undefined;
  return r?.user_id ?? null;
}

/** Does this mail exist and belong to the user? */
export function ownsEmail(db: DatabaseSync, userId: number, emailId: number): boolean {
  return db.prepare("SELECT 1 FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?").get(emailId, userId) !== undefined;
}

export function ownsAccount(db: DatabaseSync, userId: number, accountId: string): boolean {
  return db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId) !== undefined;
}

// ---- ambient user for agent tools ---------------------------------------------------------------------------------
// A tool runs inside agent.generate() and only receives what the model passes in. The request handler therefore binds
// the user to the async context; the tool reads it and fails closed when it is missing. The store lives on globalThis
// because Veryfront may load the route module and the tool module as separate instances.
// A literal property name: route modules may not read objects by a dynamic key (Veryfront loader).
interface Holder { __emailAgentTenantContext?: AsyncLocalStorage<number> }

function store(): AsyncLocalStorage<number> {
  const holder = globalThis as Holder;
  holder.__emailAgentTenantContext ??= new AsyncLocalStorage<number>();
  return holder.__emailAgentTenantContext;
}

export function runAsUser<T>(userId: number, fn: () => T): T {
  return store().run(userId, fn);
}

export function currentUserId(): number | undefined {
  return store().getStore();
}
