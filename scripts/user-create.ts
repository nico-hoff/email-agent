// Creates a user (ADR 0022). The first admin claims the owner row (id 1), so the data that existed before the multi-user
// migration stays with that person; every later call inserts a new user.
//   npm run user:create -- --email <e> [--role admin|user]            password is asked on the terminal (no echo)
//   npm run user:create -- --email <e> --password-stdin               password from stdin (scripts, CI)
// The password is never an argument (shell history, ps) and never printed.
import { validateDatabasePath } from "../lib/accounts.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { MIN_USER_PASSWORD_CHARS } from "../lib/user-password.ts";
import { createUser, USER_ROLES, type UserRole } from "../lib/users.ts";

export interface CliDeps {
  env: Record<string, string | undefined>;
  projectRoot?: string;
  /** Terminal input without echo; only used when stdin is a TTY and --password-stdin is absent. */
  promptPassword?: (label: string) => Promise<string>;
  /** Whole stdin (piped). */
  readStdin?: () => Promise<string>;
  isTty?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface UserCreateArgs { email: string; role: UserRole; passwordStdin: boolean }

export function parseUserCreateArgs(argv: readonly string[]): UserCreateArgs | { error: string } {
  let email: string | undefined;
  let role: UserRole = "admin";
  let passwordStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") email = argv[++i];
    else if (a === "--role") {
      const r = argv[++i];
      if (!(USER_ROLES as readonly string[]).includes(r ?? "")) return { error: "invalid --role (admin or user)" };
      role = r as UserRole;
    } else if (a === "--password-stdin") passwordStdin = true;
    else if (a === "--password" || a.startsWith("--password=")) return { error: "the password is never an argument: use --password-stdin or the prompt" };
    else return { error: `unknown argument ${a.startsWith("-") ? a.split("=")[0] : "(positional)"}` };
  }
  if (email === undefined || email === "") return { error: "--email is required" };
  return { email, role, passwordStdin };
}

/** Exit code: 0 ok, 1 refused (invalid input, taken), 2 usage. */
export async function userCreateMain(argv: readonly string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const args = parseUserCreateArgs(argv);
  if ("error" in args) {
    err(`user:create: ${args.error}`);
    return 2;
  }
  let password: string;
  if (args.passwordStdin) {
    password = ((await deps.readStdin?.()) ?? "").replace(/\r?\n$/, "");
  } else if (deps.isTty === true && deps.promptPassword) {
    password = await deps.promptPassword("Passwort: ");
    const again = await deps.promptPassword("Passwort wiederholen: ");
    if (again !== password) {
      err("user:create: the two entries differ");
      return 1;
    }
  } else {
    err("user:create: no terminal; pipe the password and pass --password-stdin");
    return 2;
  }
  const db = openDatabase(validateDatabasePath(deps.env, deps.projectRoot ?? PROJECT_ROOT));
  try {
    const r = await createUser(db, { email: args.email, password, role: args.role });
    if (!r.ok) {
      const text = new Map([
        ["invalid_email", "invalid email address"],
        ["weak_password", `password too short (minimum ${MIN_USER_PASSWORD_CHARS} characters)`],
        ["email_taken", "email address already registered"],
        ["invalid_role", "invalid role"],
      ]).get(r.code) ?? "refused";
      err(`user:create: ${text}`);
      return 1;
    }
    out(`user:create ok: id=${r.user.id} role=${r.user.role}${r.claimed ? " (claimed the owner row: existing data stays with this user)" : ""}`);
    return 0;
  } finally {
    db.close();
  }
}

/** Reads a line without echo from a TTY. */
export function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  try {
    process.exitCode = await userCreateMain(process.argv.slice(2), {
      env: process.env, promptPassword: promptHidden, readStdin: readAllStdin, isTty: process.stdin.isTTY === true,
    });
  } catch (e) {
    console.error(`user:create failed (${e instanceof Error ? e.name : "unknown"})`);
    process.exitCode = 1;
  }
}
