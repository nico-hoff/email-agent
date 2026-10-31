import type { DatabaseSync } from "node:sqlite";
import { defineSchema } from "veryfront/schemas";
import { tool } from "veryfront/tool";
import { validateDatabasePath } from "../lib/accounts.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { type EmailContextResult, readEmailContext } from "../lib/email-context.ts";
import type { NoulInterpreter } from "../lib/jev-response.ts";
import { currentUserId } from "../lib/tenant.ts";

export { readEmailContext };
export type { EmailContext, EmailContextResult } from "../lib/email-context.ts";

export interface GetEmailContextDeps {
  /** Returns a connection; the tool closes it after every call. */
  openDb: () => DatabaseSync;
  interpret?: NoulInterpreter;
  /** Tests pin the user; in production it comes from the request's async context (lib/tenant.ts), never from the model. */
  userId?: number;
}

const inputSchema = defineSchema((v) =>
  v.object({ email_id: v.number().int().positive().describe("ID of the email in the local database") })
)();

function toolConfig(deps: GetEmailContextDeps) {
  return {
    description:
      "Read-only context of one classified email: sender domain, subject, received time, category, question set version and the normalized classifier answers. Returns only a fixed error code when the email is not eligible.",
    inputSchema,
    mcp: { enabled: false },
    execute: ({ email_id }: { email_id: number }): Promise<EmailContextResult> => {
      const userId = deps.userId ?? currentUserId();
      // No user bound to this call: fail closed, the same answer as for an unknown mail.
      if (userId === undefined) return Promise.resolve({ ok: false, code: "email_not_found" });
      const db = deps.openDb();
      try {
        return Promise.resolve(readEmailContext(db, userId, email_id, deps.interpret));
      } finally {
        db.close();
      }
    },
  };
}

/** For tests: same tool with injected dependencies. */
export function createGetEmailContext(deps: GetEmailContextDeps) {
  return tool(toolConfig(deps));
}

export default tool(toolConfig({
  openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
}));
