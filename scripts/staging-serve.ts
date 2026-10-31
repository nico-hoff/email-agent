// Staging on Nico's Mac (ADR 0042): the real server in users mode on its OWN database (data/staging.sqlite) with REAL
// mailboxes that Nico adds in the app (Profil → Konten). IMAP workers and Jev run live; automatic mailbox actions stay
// as each account has them (new accounts: off) until Nico switches them himself. Strictly separate from the synthetic
// QA server (npm run qa:serve, data/qa-synthetic.sqlite) and from prod (fly).
//
//   npm run staging                          start on 127.0.0.1:3200 (Tailnet: tailscale serve --bg --https=8443 3200)
//   npm run staging:user -- --email <e>      first time: create your user (claims the owner row of the staging DB)
//   npm run staging -- --port 3300           other port
//
// No accounts file is read here (mailboxes come only from the app), so a legacy file is never imported into staging.
// ACCOUNTS_ENCRYPTION_KEY must be set in .env.local, otherwise no mailbox can be stored or started (fail-closed).
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { validateDatabasePath } from "../lib/accounts.ts";
import { loadKeyring } from "../lib/account-secrets.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { isOwnerUnclaimed } from "../lib/users.ts";
import { portFree, QA_NO_ACCOUNTS_FILE, runtimeProblem } from "./qa-serve.ts";

export const STAGING_DATABASE_PATH = "data/staging.sqlite";
export const STAGING_DEFAULT_PORT = 3200;

export function stagingServerEnv(base: Record<string, string | undefined>, dbPath: string, port: number): Record<string, string | undefined> {
  // Tailscale Serve terminates TLS: Veryfront must read X-Forwarded-Proto (see qa-serve.ts). Loopback listener only.
  return {
    ...base, AUTH_MODE: "users", DATABASE_PATH: dbPath, ACCOUNTS_FILE: QA_NO_ACCOUNTS_FILE, PORT: String(port), BIND_ADDRESS: "127.0.0.1",
    VERYFRONT_TRUST_FORWARDED_HEADERS: "1",
  };
}

export function parseStagingArgs(argv: readonly string[]): { port: number } | { error: string } {
  let port = STAGING_DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: "invalid --port (1024-65535)" };
    } else return { error: `unknown argument ${argv[i]}` };
  }
  return { port };
}

if (import.meta.main) {
  const args = parseStagingArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(2);
  }
  const problem = runtimeProblem(process.version, process.arch, process.platform === "darwin" && cpus().some((c) => c.model.startsWith("Apple")));
  if (problem !== null) {
    console.error(`staging: ${problem}`);
    process.exit(2);
  }
  if (!(await portFree(args.port))) {
    console.error(`staging: port ${args.port} is in use (lsof -nP -iTCP:${args.port} -sTCP:LISTEN); choose another with --port`);
    process.exit(2);
  }
  const dbPath = validateDatabasePath({ DATABASE_PATH: STAGING_DATABASE_PATH }, PROJECT_ROOT);
  const db = openDatabase(dbPath);
  let unclaimed: boolean;
  try {
    unclaimed = isOwnerUnclaimed(db);
  } finally {
    db.close();
  }
  if (unclaimed) console.log("staging: no user yet; create yours first: npm run staging:user -- --email <your address>");
  if (!loadKeyring(process.env).ok) console.log("staging: ACCOUNTS_ENCRYPTION_KEY missing or invalid in .env.local: mailboxes cannot be stored or started (fail-closed)");
  console.log(`staging: starting the server in users mode on 127.0.0.1:${args.port} (database ${STAGING_DATABASE_PATH}); Tailnet: tailscale serve --bg --https=8443 ${args.port}`);
  const child = spawn(process.execPath, ["--env-file-if-exists=.env.local", "server.ts", "--development"], {
    cwd: PROJECT_ROOT, stdio: "inherit", env: stagingServerEnv(process.env, dbPath, args.port),
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 0));
}
