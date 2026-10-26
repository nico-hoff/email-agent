import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const DEFAULT_ACCOUNTS_FILE = "data/accounts.json";
export const DEFAULT_SPAM_THRESHOLD = 0.95;

const nonEmpty = z.string().min(1);

const accountSchema = z.strictObject({
  id: nonEmpty,
  label: nonEmpty,
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
});
const accountsSchema = z.array(accountSchema);

export type AccountConfig = z.infer<typeof accountSchema>;
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

/** Loads and validates the accounts file. Messages name fields, never values. */
export function loadAccountsConfig(opts: LoadOptions): AccountsConfigResult {
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
