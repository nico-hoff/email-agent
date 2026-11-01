// Simulation of the initial import for QA and screenshots (ADR 0043). NOT part of the product: nothing in server.ts, the
// Dockerfile or the fly config reaches this file. It starts the REAL server (users mode, real routes, real IMAP worker,
// real classification pipeline and persistence) with two things replaced: the IMAP port (a synthetic INBOX in memory, no
// socket) and the Jev client (a synthetic verdict per mail after a short delay, no network, no model call). So the view
// can be watched and photographed without any real mailbox.
//
//   node scripts/sync-sim.ts [--port 3410] [--reset] [--connect-ms 2500] [--fetch-ms 150] [--jev-ms 900]
//   open http://127.0.0.1:3410, sign in as qa@synthetic.invalid / qqqqqq, Profil → Konto hinzufügen (any address, any
//   password, server imap.example.test): the import of the fake mailbox starts.
//
// Safety: refuses to run on fly (FLY_* variables) or with NODE_ENV=production, binds 127.0.0.1 only, uses its own database
// data/sync-sim.sqlite and a key generated per start. The accounts it creates have no real credentials.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { generateKey } from "../lib/account-secrets.ts";
import { validateDatabasePath } from "../lib/accounts.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import type { HeaderInfo, ImapPort } from "../lib/imap.ts";
import type { JevCallResult, JevClient } from "../lib/jev.ts";
import { createService, createSupervisedWorkers } from "../server.ts";
import { createImapWorkers } from "../workers/imap-worker.ts";
import { ensureQaUser, portFree, QA_NO_ACCOUNTS_FILE, QA_PASSWORD, QA_USER_EMAIL, runtimeProblem } from "./qa-serve.ts";

export const SIM_DATABASE_PATH = "data/sync-sim.sqlite";
export const SIM_DEFAULT_PORT = 3410;
export const SIM_MAILS = 60;
/** The oldest of the fake mails are "older than 14 days": the fake SEARCH SINCE leaves them out. */
export const SIM_OLD_MAILS = 8;

export interface SimDelays { connectMs: number; fetchMs: number; jevMs: number }
export const DEFAULT_DELAYS: SimDelays = { connectMs: 2500, fetchMs: 150, jevMs: 900 };

/** Refuses anything that looks like a deployment. */
export function simGuard(env: Record<string, string | undefined>): string | null {
  if (env.FLY_APP_NAME || env.FLY_ALLOC_ID || env.FLY_MACHINE_ID) return "sync-sim refuses to run on fly";
  if (env.NODE_ENV === "production") return "sync-sim refuses to run with NODE_ENV=production";
  return null;
}

interface Template { subject: string; from: string; category: string; route: string; urgency: number; importance: number; spam: number; reply: number }
const T = (subject: string, from: string, category: string, route: string, urgency: number, importance: number, spam = 0.02, reply = 0.05): Template =>
  ({ subject, from, category, route, urgency, importance, spam, reply });
export const TEMPLATES: readonly Template[] = [
  T("Ihre Rechnung Nr. 20261031 ist da", "Stadtwerke Beispielstadt <rechnung@stadtwerke.example.test>", "transactional", "notify", 1, 2),
  T("Termin morgen um 10 Uhr: Bitte kurz bestätigen", "Dr. Muster <praxis@muster.example.test>", "business", "draft_reply", 2, 2, 0.02, 0.92),
  T("Gewinnen Sie jetzt 1000 Euro! Nur heute", "Aktion <win@gluecks-lotterie.example.test>", "spam", "ignore", 0, 0, 0.99),
  T("Dein Wochenrückblick: 5 neue Artikel", "Newsletter <news@wochenblick.example.test>", "newsletter_promo", "ignore", 0, 0, 0.05),
  T("Sicherheitswarnung: neue Anmeldung erkannt", "Konto-Sicherheit <security@mail.example.test>", "security_auth", "notify", 2, 3),
  T("Kommst du am Samstag zum Essen?", "Anna <anna@familie.example.test>", "personal", "draft_reply", 1, 1, 0.01, 0.88),
  T("Deine Bestellung wurde versendet", "Shop <versand@kleiner-shop.example.test>", "transactional", "digest", 0, 1),
  T("Angebot für die Büroausstattung", "Vertrieb <angebot@buero-bedarf.example.test>", "business", "notify", 1, 2, 0.1, 0.6),
  T("Letzte Mahnung: Zahlung offen", "Inkasso <mahnung@zahlung-info.example.test>", "spam", "ignore", 1, 0, 0.93),
  T("Protokoll der Besprechung vom Donnerstag", "Team <team@firma.example.test>", "business", "digest", 0, 1),
  T("Willkommen bei Kochfreunde", "Kochfreunde <hallo@kochfreunde.example.test>", "newsletter_promo", "ignore", 0, 0, 0.04),
  T("Steuerbescheid 2025: Bitte Unterlagen prüfen", "Finanzamt <post@finanzverwaltung.example.test>", "business", "notify", 2, 3),
];

export function simMessage(uid: number, now: Date): { subject: string; from: string; source: Buffer } {
  const t = TEMPLATES[uid % TEMPLATES.length]!;
  const date = new Date(now.getTime() - (SIM_MAILS - uid) * 3 * 3_600_000);
  const source = `Message-ID: <sim-${uid}@sim.example.test>\r\nFrom: ${t.from}\r\nSubject: ${t.subject}\r\nDate: ${date.toUTCString()}\r\n\r\nSynthetischer Inhalt ${uid}.`;
  return { subject: t.subject, from: t.from, source: Buffer.from(source) };
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** In-memory INBOX with SIM_MAILS synthetic mails. Read-only like the real port: it has no write method at all. */
export function createSimPort(d: SimDelays, now: () => Date = () => new Date()): ImapPort {
  const handlers = new Map<string, (...a: never[]) => void>();
  const uids = Array.from({ length: SIM_MAILS }, (_, i) => i + 1);
  return {
    async connect() { await sleep(d.connectMs); },
    async mailboxStatus() { return { uidValidity: 1, highestUid: SIM_MAILS }; },
    async fetchHeadersSince(_f: string, after: number): Promise<HeaderInfo[]> {
      return uids.filter((u) => u > after).map((uid) => ({ uid, messageId: `<sim-${uid}@sim.example.test>`, seen: uid % 4 === 0 }));
    },
    async fetchFlags(_f: string, ask: number[]) { return ask.map((uid) => ({ uid, seen: uid % 4 === 0 })); },
    async searchUids(_f: string, o: { since: Date; maxUid: number }) { return uids.filter((u) => u > SIM_OLD_MAILS && u <= o.maxUid); },
    async fetchMessageByUid(_f: string, uid: number) { await sleep(d.fetchMs); return { uid, source: simMessage(uid, now()).source }; },
    async watch() {},
    on(event: string, cb: (...a: never[]) => void) { handlers.set(event, cb); },
    async close() {},
  } as ImapPort;
}

/** A synthetic verdict per subject, in the shape of the SDK response (so the real validation and persistence run). */
export function createSimJev(d: SimDelays): JevClient {
  const fixture = JSON.parse(readFileSync(join(PROJECT_ROOT, "tests", "fixtures", "jev-email-v2-response.json"), "utf8")) as {
    answers: Record<string, Record<string, unknown>>; model: string;
  };
  const bySubject = new Map(TEMPLATES.map((t) => [t.subject, t] as const));
  const oneHot = (keys: string[], hit: string) => Object.fromEntries(keys.map((k) => [k, k === hit ? 0.9 : 0.1 / (keys.length - 1)]));
  return {
    async classify(input): Promise<JevCallResult> {
      await sleep(d.jevMs);
      const subject = (input.state as { untrusted_subject?: string }).untrusted_subject ?? "";
      const t = bySubject.get(subject) ?? TEMPLATES[0]!;
      const a = structuredClone(fixture.answers);
      const set = (key: string, patch: Record<string, unknown>) => { a[key] = { ...a[key], ...patch }; };
      const cats = Object.keys(a.category!.probabilities as object);
      const routes = Object.keys(a.route!.probabilities as object);
      set("category", { choice: t.category, probabilities: oneHot(cats, t.category) });
      set("route", { choice: t.route, probabilities: oneHot(routes, t.route) });
      set("importance", { score: t.importance, probabilities: oneHot(["0", "1", "2", "3"], String(t.importance)) });
      set("urgency", { score: t.urgency, probabilities: oneHot(["0", "1", "2", "3"], String(t.urgency)) });
      set("is_spam", { noul: t.spam });
      set("needs_my_reply", { noul: t.reply });
      return { ok: true, response: { ...fixture, answers: a, model: fixture.model } as never };
    },
  };
}

export function parseSimArgs(argv: readonly string[]): { port: number; reset: boolean; delays: SimDelays } | { error: string } {
  let port = SIM_DEFAULT_PORT;
  let reset = false;
  const delays = { ...DEFAULT_DELAYS };
  const num = (v: string | undefined): number => (v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : NaN);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reset") reset = true;
    else if (arg === "--port") { port = num(argv[++i]); if (!(port >= 1024 && port <= 65535)) return { error: "invalid --port (1024-65535)" }; }
    else if (arg === "--connect-ms" || arg === "--fetch-ms" || arg === "--jev-ms") {
      const v = num(argv[++i]);
      if (!Number.isFinite(v)) return { error: `invalid ${arg}` };
      if (arg === "--connect-ms") delays.connectMs = v; else if (arg === "--fetch-ms") delays.fetchMs = v; else delays.jevMs = v;
    } else return { error: `unknown argument ${arg}` };
  }
  return { port, reset, delays };
}

if (import.meta.main) {
  const args = parseSimArgs(process.argv.slice(2));
  const fail = (m: string): never => { console.error(`sync-sim: ${m}`); process.exit(2); };
  if ("error" in args) fail(args.error);
  const guard = simGuard(process.env);
  if (guard) fail(guard);
  const a = args as Exclude<typeof args, { error: string }>;
  const problem = runtimeProblem(process.version, process.arch, process.platform === "darwin" && cpus().some((c) => c.model.startsWith("Apple")));
  if (problem !== null) fail(problem);
  if (!(await portFree(a.port))) fail(`port ${a.port} is in use`);
  const dbPath = validateDatabasePath({ DATABASE_PATH: SIM_DATABASE_PATH }, PROJECT_ROOT);
  if (a.reset) for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  const db = openDatabase(dbPath);
  try {
    await ensureQaUser(db);
  } finally {
    db.close();
  }
  Object.assign(process.env, {
    AUTH_MODE: "users", DATABASE_PATH: dbPath, ACCOUNTS_FILE: QA_NO_ACCOUNTS_FILE, ACCOUNTS_ENCRYPTION_KEY: generateKey(),
    BIND_ADDRESS: "127.0.0.1",
  });
  // The pipeline needs *a* key to be wired; it goes only to the pipeline (never into process.env: the briefing and reply agents
  // would then try a real call). The fake Jev client never uses it.
  const pipelineEnv = { ...process.env, OPENROUTER_API_KEY: "sim-not-a-key" };
  const svc = await createService({
    port: a.port, bindAddress: "127.0.0.1", mode: "development", env: process.env,
    createWorkers: ({ db: wdb }) => createSupervisedWorkers({ db: wdb }, {
      env: pipelineEnv, intervalMs: 1000, log: (m) => console.log(`sim: ${m}`),
      createJev: () => createSimJev(a.delays), portFactory: () => createSimPort(a.delays),
      createWorkers: (d) => createImapWorkers({ ...d, createPort: () => createSimPort(a.delays) }),
    }),
  });
  console.log(`sync-sim: ${svc.url} (fake mailbox, fake Jev). Sign in as ${QA_USER_EMAIL} / ${QA_PASSWORD}, then Profil → Konto hinzufügen.`);
}
