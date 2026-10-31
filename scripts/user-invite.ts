// Prints a one-time invitation code (ADR 0022). Only the hash is stored; the code appears here once, for the operator.
//   npm run user:invite -- [--role user|admin] [--days 7] [--by <admin email>]
// Without --by the invitation belongs to the owner (id 1) if that is an active admin, else the first active admin.
import { validateDatabasePath } from "../lib/accounts.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { createInvite, findUserByEmail, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, USER_ROLES, type UserRole } from "../lib/users.ts";
import type { CliDeps } from "./user-create.ts";

export interface UserInviteArgs { role: UserRole; days: number; by: string | undefined }

export function parseUserInviteArgs(argv: readonly string[]): UserInviteArgs | { error: string } {
  let role: UserRole = "user";
  let days = INVITE_DEFAULT_DAYS;
  let by: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") {
      const r = argv[++i];
      if (!(USER_ROLES as readonly string[]).includes(r ?? "")) return { error: "invalid --role (user or admin)" };
      role = r as UserRole;
    } else if (a === "--days") {
      const d = Number(argv[++i]);
      if (!Number.isInteger(d) || d < 1 || d > INVITE_MAX_DAYS) return { error: `--days must be 1 to ${INVITE_MAX_DAYS}` };
      days = d;
    } else if (a === "--by") by = argv[++i];
    else return { error: `unknown argument ${a.startsWith("-") ? a.split("=")[0] : "(positional)"}` };
  }
  return { role, days, by };
}

export async function userInviteMain(argv: readonly string[], deps: Pick<CliDeps, "env" | "projectRoot" | "out" | "err">, now?: Date): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const args = parseUserInviteArgs(argv);
  if ("error" in args) {
    err(`user:invite: ${args.error}`);
    return 2;
  }
  const db = openDatabase(validateDatabasePath(deps.env, deps.projectRoot ?? PROJECT_ROOT));
  try {
    let creator: number | undefined;
    if (args.by !== undefined) {
      const u = findUserByEmail(db, args.by);
      creator = u && u.status === "active" && u.role === "admin" ? u.id : undefined;
    } else {
      creator = (db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id;
    }
    if (creator === undefined) {
      err("user:invite: no active admin; create one first with npm run user:create");
      return 1;
    }
    const inv = createInvite(db, { createdBy: creator, role: args.role, days: args.days, ...(now ? { now } : {}) });
    out(`Einladungscode (wird nur jetzt angezeigt): ${inv.code}`);
    out(`Rolle: ${inv.role}, gültig bis ${inv.expires_at}`);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await userInviteMain(process.argv.slice(2), { env: process.env });
  } catch (e) {
    console.error(`user:invite failed (${e instanceof Error ? e.name : "unknown"})`);
    process.exitCode = 1;
  }
}
