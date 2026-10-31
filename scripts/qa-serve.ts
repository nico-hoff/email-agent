// QA server for the iPhone over Tailscale: the REAL server (users mode, not the loopback-only synthetic dev mode) on a
// separate database filled with synthetic mails only. No accounts file, so no IMAP worker runs; nothing touches a real
// mailbox. The answers of the QA mails are SIMULATED from the expected topic of the synthetic fixture (no Jev call).
//
//   npm run qa:serve                      seed data/qa-synthetic.sqlite if empty, ensure the QA user, start on 127.0.0.1:3100
//   npm run qa:serve -- --reset           delete the QA database first (fresh data, new password)
//   npm run qa:serve -- --port 3200       other port
// Then (Nico, once): `tailscale serve --bg 3100` and open https://<machine>.<tailnet>.ts.net on the iPhone.
//
// The QA user is qa@synthetic.invalid with the fixed password "qqqqqq" (only synthetic data, loopback + own tailnet).
// Mail data is never printed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { validateDatabasePath } from "../lib/accounts.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import type { EvalCase } from "../lib/eval-sources.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";
import type { NormalizedAnswer } from "../lib/jev-response.ts";
import { importSyntheticCases, type SyntheticItem } from "../lib/synthetic-dev-db.ts";
import { hashPassword } from "../lib/user-password.ts";
import { createUser, findUserByEmail } from "../lib/users.ts";
import { smokeItems } from "./e2e-smoke.ts";

export const QA_DATABASE_PATH = "data/qa-synthetic.sqlite";
export const QA_USER_EMAIL = "qa@synthetic.invalid";
/** Absolute path that never exists: the server then finds no accounts file and starts no IMAP worker. */
export const QA_NO_ACCOUNTS_FILE = "/nonexistent/email-agent-qa/no-accounts.json";
const TOPICS_FIXTURE = join(PROJECT_ROOT, "tests", "fixtures", "eval", "topics-synthetic.jsonl");
const PER_TOPIC = 3;
/** Not 3000: other local tools often hold it (seen on the Mac: a WhatsApp bridge and a Docker container). */
export const QA_DEFAULT_PORT = 3100;
export const REQUIRED_NODE = "26.12.1";

/** Node must be the pinned version on the machine's native architecture: native modules (esbuild) are installed for it. */
export function runtimeProblem(version: string, arch: string, hostArm64: boolean): string | null {
  if (version !== `v${REQUIRED_NODE}`) return `node ${version} found, ${REQUIRED_NODE} required (nvm use; check that no other node comes first in PATH)`;
  if (hostArm64 && arch !== "arm64") return `node runs as ${arch} on an arm64 Mac (Rosetta/Intel Homebrew?): esbuild is installed for arm64`;
  return null;
}

/** True when the port can be bound on 127.0.0.1. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

interface Profile { category: string; route: string; urgency: number; importance: number; needsReply: number; spam: number }

/** Simulated answers per expected topic: plausible spread over the views (Wichtig, Offen, Aussortiert). */
export function profileForTopic(topic: string, n: number): Profile {
  const base: Profile = { category: "business", route: "digest", urgency: 0, importance: 1, needsReply: 0.1, spam: 0.02 };
  switch (topic) {
    case "newsletter": return { ...base, category: "newsletter_promo", route: "ignore", importance: 0 };
    case "shopping": return { ...base, category: "transactional", route: "digest" };
    case "finance": return { ...base, category: "transactional", route: "notify", urgency: n === 0 ? 2 : 1, importance: 2 };
    case "work": return { ...base, category: "business", route: "draft_reply", urgency: 2, importance: 2, needsReply: 0.9 };
    case "family": return { ...base, category: "personal", route: "draft_reply", urgency: 1, importance: 1, needsReply: 0.85 };
    case "official": return { ...base, category: "business", route: "notify", urgency: 1, importance: 3 };
    case "health": return { ...base, category: "personal", route: "notify", urgency: n === 0 ? 3 : 1, importance: 3 };
    case "travel": return { ...base, category: "transactional", route: "notify", urgency: 1, importance: 2 };
    default: return base;
  }
}

function answersFor(p: Profile): NormalizedAnswer[] {
  const noul = new Map<string, number>([["is_spam", p.spam], ["needs_my_reply", p.needsReply], ["is_assessable", 0.9]]);
  const choice = new Map<string, string>([["category", p.category], ["route", p.route]]);
  const score = new Map<string, number>([["urgency", p.urgency], ["importance", p.importance]]);
  return Object.entries(QUESTIONS).map(([key, q]) =>
    q.type === "noul" ? { key, type: "noul" as const, value: noul.get(key) ?? 0.03 }
    : q.type === "choice" ? { key, type: "choice" as const, value: choice.get(key) ?? Object.keys(q.criteria)[0] }
    : { key, type: "score" as const, value: score.get(key) ?? 0 });
}

/** The first PER_TOPIC synthetic mails of every topic in the fixture, plus the built-in smoke set (spam, provider spam). */
export function qaItems(fixtureText: string = readFileSync(TOPICS_FIXTURE, "utf8")): SyntheticItem[] {
  const counts = new Map<string, number>();
  const items: SyntheticItem[] = [];
  for (const line of fixtureText.split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { id: string; lang: string; sender_domain: string; subject: string; expected_topic: string };
    const n = counts.get(row.expected_topic) ?? 0;
    if (n >= PER_TOPIC) continue;
    counts.set(row.expected_topic, n + 1);
    // Body is deliberately empty: nothing of it is stored anyway, and the QA mails are never classified live.
    const c: EvalCase = { id: `qa-${row.id}`, source: n % 2 === 0 ? "sinabis" : "triage", lang: row.lang, sender_domain: row.sender_domain, subject: row.subject, body: "", expected: {} };
    items.push({ case: c, classification: { answers: answersFor(profileForTopic(row.expected_topic, n)), modelReported: "qa-simulated" } });
  }
  return [...items, ...smokeItems()];
}

export function seedQaDatabase(db: DatabaseSync, now: Date = new Date()): { seeded: boolean; cases: number } {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number };
  if (n > 0) return { seeded: false, cases: n };
  const r = importSyntheticCases(db, qaItems(), { now });
  return { seeded: true, cases: r.cases };
}

/** Claims the owner row as the QA user (fresh database) and returns the new password, or null when the user exists. */
/**
 * Fixed QA password (Nico's wish, 2026-10-31): it guards only the synthetic QA database, reachable on loopback and in
 * the own tailnet. It deliberately bypasses the 12-character rule of real users, so it is set as a hash directly here
 * and nowhere else; `createUser` and registration keep the rule.
 */
export const QA_PASSWORD = "qqqqqq";

/** Ensures the QA user (claims the owner row on a fresh database) and (re)sets its password to QA_PASSWORD on every start. */
export async function ensureQaUser(db: DatabaseSync, password: string = QA_PASSWORD): Promise<{ created: boolean }> {
  let user = findUserByEmail(db, QA_USER_EMAIL);
  let created = false;
  if (user === null) {
    const r = await createUser(db, { email: QA_USER_EMAIL, password: randomBytes(18).toString("base64url"), role: "admin" });
    if (!r.ok) throw new Error(`qa user not created (${r.code})`);
    user = r.user;
    created = true;
  }
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(await hashPassword(password), new Date().toISOString(), user.id);
  return { created };
}

export function qaServerEnv(base: Record<string, string | undefined>, dbPath: string, port: number): Record<string, string | undefined> {
  // Tailscale Serve terminates TLS and forwards plain HTTP to 127.0.0.1: Veryfront must trust X-Forwarded-Proto, otherwise
  // it names its CSRF cookie for http://<host> and every POST from the https page fails with 403. The listener is
  // loopback-only, so only this machine and Tailscale Serve can set the header.
  return {
    ...base, AUTH_MODE: "users", DATABASE_PATH: dbPath, ACCOUNTS_FILE: QA_NO_ACCOUNTS_FILE, PORT: String(port), BIND_ADDRESS: "127.0.0.1",
    VERYFRONT_TRUST_FORWARDED_HEADERS: "1",
  };
}

export function parseQaArgs(argv: readonly string[]): { reset: boolean; port: number } | { error: string } {
  let reset = false;
  let port = QA_DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reset") reset = true;
    else if (argv[i] === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: "invalid --port (1024-65535)" };
    } else return { error: `unknown argument ${argv[i]}` };
  }
  return { reset, port };
}

if (import.meta.main) {
  const args = parseQaArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(2);
  }
  const problem = runtimeProblem(process.version, process.arch, process.platform === "darwin" && cpus().some((c) => c.model.startsWith("Apple")));
  if (problem !== null) {
    console.error(`qa: ${problem}`);
    process.exit(2);
  }
  if (!(await portFree(args.port))) {
    console.error(`qa: port ${args.port} is in use (lsof -nP -iTCP:${args.port} -sTCP:LISTEN); choose another with --port`);
    process.exit(2);
  }
  const dbPath = validateDatabasePath({ DATABASE_PATH: QA_DATABASE_PATH }, PROJECT_ROOT);
  if (args.reset) for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  const db = openDatabase(dbPath);
  let created = false;
  try {
    const s = seedQaDatabase(db);
    console.log(s.seeded ? `qa: ${s.cases} synthetic mails seeded (answers simulated, no Jev call)` : `qa: database has ${s.cases} mails, kept`);
    created = (await ensureQaUser(db)).created;
  } finally {
    db.close();
  }
  console.log(`qa: user ${QA_USER_EMAIL} ${created ? "created" : "exists"}, password: ${QA_PASSWORD}`);
  console.log(`qa: starting the server in users mode on 127.0.0.1:${args.port}; for the iPhone: tailscale serve --bg ${args.port}`);
  const child = spawn(process.execPath, ["--env-file-if-exists=.env.local", "server.ts", "--development"], {
    cwd: PROJECT_ROOT, stdio: "inherit", env: qaServerEnv(process.env, dbPath, args.port),
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 0));
}
