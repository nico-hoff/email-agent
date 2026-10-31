import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { DEFAULT_ACCOUNTS_FILE } from "./constants.ts";

export { DEFAULT_ACCOUNTS_FILE };
export const DEFAULT_SPAM_THRESHOLD = 0.95;

const nonEmpty = z.string().min(1);

/** Per-account switch of an automatic mailbox action (Plan v5 H18). `dry_run` only records what would happen. */
export const AUTO_ACTION_MODES = ["off", "dry_run", "live"] as const;
export type AutoActionMode = (typeof AUTO_ACTION_MODES)[number];
/** Without an explicit `live` nothing is ever written to a mailbox. */
export const DEFAULT_AUTO_ACTION_MODE: AutoActionMode = "dry_run";

const accountSchema = z.strictObject({
  id: nonEmpty,
  label: nonEmpty,
  /** Tag color on mail cards (#rrggbb, stored in lower case). Optional: the app falls back to a stable palette color. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((c) => c.toLowerCase()).optional(),
  context: z.string(),
  host: nonEmpty,
  port: z.number().int().min(1).max(65535),
  tls: z.boolean(),
  user: nonEmpty,
  password: nonEmpty,
  mailbox: nonEmpty,
  spam_mailbox: nonEmpty.optional(),
  spam_threshold: z.number().min(0).max(1).default(DEFAULT_SPAM_THRESHOLD),
  enabled: z.boolean(),
  /** Automatic mailbox actions (M7a). Absent = every action in dry_run. */
  auto_actions: z.strictObject({ spam_seen: z.enum(AUTO_ACTION_MODES).default(DEFAULT_AUTO_ACTION_MODE) }).optional(),
});
const accountsSchema = z.array(accountSchema);

export type AccountConfig = z.infer<typeof accountSchema>;
export function autoActionMode(account: Pick<AccountConfig, "auto_actions">, action: "spam_seen"): AutoActionMode {
  // No dynamic key access: the Veryfront API loader rejects it in modules that routes import.
  return action === "spam_seen" ? account.auto_actions?.spam_seen ?? DEFAULT_AUTO_ACTION_MODE : DEFAULT_AUTO_ACTION_MODE;
}
export type AccountsConfigResult =
  | { status: "disabled" }
  | { status: "ok"; accounts: AccountConfig[] };

export class AccountsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsConfigError";
  }
}

export interface LoadOptions {
  env: Record<string, string | undefined>;
  projectRoot: string;
}

function fieldPath(path: PropertyKey[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join("") || "(root)";
}

/** Resolves and checks the location of the legacy accounts file (absolute, inside the repo only under data/). Reads nothing. */
export function resolveAccountsFile(opts: LoadOptions): string {
  const configured = opts.env.ACCOUNTS_FILE;
  let file: string;
  if (configured === undefined || configured === "") {
    file = resolve(opts.projectRoot, DEFAULT_ACCOUNTS_FILE);
  } else if (!isAbsolute(configured)) {
    throw new AccountsConfigError("ACCOUNTS_FILE: relative paths are not allowed, use an absolute path");
  } else {
    file = resolve(configured);
  }

  const rel = relative(resolve(opts.projectRoot), file);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (insideRepo && !rel.startsWith(`data${sep}`)) {
    throw new AccountsConfigError("ACCOUNTS_FILE: inside the project it must live under data/");
  }
  return file;
}

/** Does the legacy accounts file exist (any kind of entry)? Does not open or read it. */
export function accountsFileExists(opts: LoadOptions): boolean {
  try {
    lstatSync(resolveAccountsFile(opts));
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads and validates the LEGACY accounts file (R2: read once by the import, never by the running app).
 * Messages name fields, never values.
 */
export function loadAccountsConfig(opts: LoadOptions): AccountsConfigResult {
  const file = resolveAccountsFile(opts);

  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "disabled" };
    throw new AccountsConfigError("ACCOUNTS_FILE: cannot be inspected");
  }
  if (st.isSymbolicLink()) throw new AccountsConfigError("ACCOUNTS_FILE: symlinks are not allowed");
  if (!st.isFile()) throw new AccountsConfigError("ACCOUNTS_FILE: must be a regular file");
  if ((st.mode & 0o077) !== 0) {
    throw new AccountsConfigError("ACCOUNTS_FILE: file mode must not grant group/other access (use 0600)");
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new AccountsConfigError("ACCOUNTS_FILE: content is not valid JSON");
  }

  const parsed = accountsSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => {
      const keys = i.code === "unrecognized_keys" ? (i as { keys: string[] }).keys : [];
      return keys.length > 0
        ? keys.map((k) => fieldPath([...i.path, k])).join(", ")
        : fieldPath(i.path);
    }))];
    throw new AccountsConfigError(`ACCOUNTS_FILE: invalid fields: ${fields.join("; ")}`);
  }

  const seen = new Set<string>();
  const dups: string[] = [];
  parsed.data.forEach((a, i) => {
    if (seen.has(a.id)) dups.push(`[${i}].id`);
    seen.add(a.id);
  });
  if (dups.length > 0) {
    throw new AccountsConfigError(`ACCOUNTS_FILE: duplicate id at ${dups.join(", ")}`);
  }
  return { status: "ok", accounts: parsed.data };
}
