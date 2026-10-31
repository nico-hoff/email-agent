// Syncs the app's secrets from a local env file (default `.env.local`, else `.env`) to fly.io via `fly secrets import`.
// Source of truth is the local, git-ignored env file. Secrets are never written into the repo.
//
// Safety:
// - Only names from the SECRETS catalog below are sent (allowlist). Other names are skipped and listed by name only.
// - Values go to fly only through stdin, never as command-line arguments (those are visible in `ps` and shell history).
// - Output and error messages contain names, never values.
//
// Aufruf:
//   node scripts/fly-secrets.ts check [--env-file F] [--app A]      validate, show the plan (default; contacts nothing)
//   node scripts/fly-secrets.ts status [--env-file F] [--app A]     like check, plus compare names with `fly secrets list`
//   node scripts/fly-secrets.ts sync [--env-file F | --from-env] [--app A] [--profile prod] [--stage] [--prune] [--keep A,B] [--force]
//     --from-env  take the values from the process environment instead of a file (GitHub Actions: environment secrets
//                 mapped into env). Only catalog names are read; nothing else of the environment is looked at.
//     --profile prod  the production secrets (ACCOUNTS_ENCRYPTION_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) are required;
//                 default profile: they are optional (still validated when present), e.g. for preview apps
//     --stage   set without restarting the Machine (takes effect on the next `fly deploy`)
//     --prune   also unset secrets on fly that the env file does not send (fly then matches the file);
//               PRUNE_KEEP and --keep names are never unset
//     --force   no confirmation prompt (required without a terminal). Never skips the validation.
// Makefile: make fly-secrets-check | fly-secrets-status | fly-secrets-sync | fly-secrets-stage | fly-secrets-prune
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import { appPasswordStatus } from "../lib/auth.ts";

export interface SecretSpec {
  name: string;
  required: boolean;
  /** Required with `--profile prod` (optional otherwise). */
  prodRequired?: boolean;
  purpose: string;
  /** Returns an error code for an unusable value, or null. Never returns the value. */
  validate?: (value: string) => string | null;
}

export const SECRETS: readonly SecretSpec[] = [
  {
    name: "APP_PASSWORD",
    required: true,
    purpose: "Passwort-Login (auf fly Pflicht, mindestens 16 Zeichen)",
    validate: (v) => (appPasswordStatus(v) === "ok" ? null : "zu kurz (mindestens 16 Zeichen)"),
  },
  { name: "OPENROUTER_API_KEY", required: true, purpose: "Jev und Agenten über OpenRouter" },
  { name: "OPENAI_API_KEY", required: false, purpose: "nur wenn die Agenten direkt zu OpenAI statt OpenRouter sollen" },
  {
    name: "ACCOUNTS_ENCRYPTION_KEY",
    required: false,
    prodRequired: true,
    purpose: "Schlüssel für die verschlüsselten Postfach-Zugangsdaten (32 Byte, base64)",
    validate: (v) => (base64Bytes(v, false) === 32 ? null : "kein base64 mit genau 32 Byte (openssl rand -base64 32)"),
  },
  {
    name: "VAPID_PUBLIC_KEY",
    required: false,
    prodRequired: true,
    purpose: "Web-Push (VAPID), öffentlicher Schlüssel (65 Byte, base64url)",
    validate: (v) => (base64Bytes(v, true) === 65 ? null : "kein base64url mit genau 65 Byte"),
  },
  {
    name: "VAPID_PRIVATE_KEY",
    required: false,
    prodRequired: true,
    purpose: "Web-Push (VAPID), privater Schlüssel (32 Byte, base64url)",
    validate: (v) => (base64Bytes(v, true) === 32 ? null : "kein base64url mit genau 32 Byte"),
  },
  {
    name: "VAPID_SUBJECT",
    required: false,
    purpose: "Web-Push (VAPID), Kontakt als mailto: oder https:// (vorerst optional)",
    validate: (v) => (/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(v) ? null : "weder mailto: noch https://"),
  },
];

/** Decoded byte length of a base64 (or base64url) string, or null when it is not valid. Never returns or logs the value. */
export function base64Bytes(value: string, url: boolean): number | null {
  const re = url ? /^[A-Za-z0-9_-]+={0,2}$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!re.test(value)) return null;
  if (!url && value.length % 4 !== 0) return null; // standard base64 is always padded (openssl rand -base64)
  const std = url ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
  const bytes = Buffer.from(std, "base64");
  // Reject strings that do not survive a round trip (wrong padding, stray bits).
  if (bytes.toString("base64").replace(/=+$/, "") !== std.replace(/=+$/, "")) return null;
  return bytes.length;
}

/** Plain configuration, set in fly.toml [env]. Never sent as secrets, so a local value cannot override fly.toml. */
export const FLY_TOML_CONFIG: readonly string[] = ["BIND_ADDRESS", "DATABASE_PATH", "PORT", "ACCOUNTS_FILE", "NODE_ENV"];

const PLACEHOLDER = /REPLACE_ME|^<.*>$|^changeme$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvParseError extends Error {
  constructor(line: number, reason: string) {
    super(`env file line ${line}: ${reason}`);
    this.name = "EnvParseError";
  }
}

/**
 * Minimal dotenv parser: `NAME=VALUE`, optional `export `, `#` comments, blank lines, single or double quotes
 * around the whole value. Multi-line values are refused. Errors name the line, never the content.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) throw new EnvParseError(i + 1, "expected NAME=VALUE");
    const name = body.slice(0, eq).trim();
    if (!NAME.test(name)) throw new EnvParseError(i + 1, "invalid name");
    let value = body.slice(eq + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      if (value.length < 2 || value[value.length - 1] !== q) throw new EnvParseError(i + 1, "unterminated quote (multi-line values are not supported)");
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out.set(name, value);
  });
  return out;
}

export interface Plan {
  send: string[];
  missingRequired: string[];
  invalid: { name: string; reason: string }[];
  emptyOptional: string[];
  config: string[];
  unknown: string[];
  /** NAME=VALUE lines for stdin; only built when the plan is usable. */
  stdin: string;
  ok: boolean;
}

export type Profile = "default" | "prod";

export function buildPlan(env: Map<string, string>, catalog: readonly SecretSpec[] = SECRETS, profile: Profile = "default"): Plan {
  const send: string[] = [];
  const missingRequired: string[] = [];
  const invalid: { name: string; reason: string }[] = [];
  const emptyOptional: string[] = [];
  const lines: string[] = [];
  for (const spec of catalog) {
    const value = env.get(spec.name) ?? "";
    if (value === "") {
      (spec.required || (profile === "prod" && spec.prodRequired) ? missingRequired : emptyOptional).push(spec.name);
      continue;
    }
    if (PLACEHOLDER.test(value)) {
      invalid.push({ name: spec.name, reason: "Platzhalter statt echtem Wert" });
      continue;
    }
    if (/[\r\n]/.test(value)) {
      invalid.push({ name: spec.name, reason: "mehrzeilig, nicht unterstützt" });
      continue;
    }
    if (!flySafe(value)) {
      invalid.push({ name: spec.name, reason: "enthält vor dem ersten # eine ungerade Zahl von \" (fly würde den Wert kürzen)" });
      continue;
    }
    const err = spec.validate?.(value) ?? null;
    if (err) {
      invalid.push({ name: spec.name, reason: err });
      continue;
    }
    send.push(spec.name);
    lines.push(`${spec.name}=${encodeForFly(value)}`);
  }
  const known = new Set(catalog.map((s) => s.name));
  const config = [...env.keys()].filter((k) => FLY_TOML_CONFIG.includes(k));
  const unknown = [...env.keys()].filter((k) => !known.has(k) && !FLY_TOML_CONFIG.includes(k));
  const ok = missingRequired.length === 0 && invalid.length === 0;
  return { send, missingRequired, invalid, emptyOptional, config, unknown, stdin: ok ? lines.join("\n") + "\n" : "", ok };
}

/**
 * `fly secrets import` (flyctl internal/command/secrets/parser.go) cuts a value at the first `#` when the text before
 * it holds an even number of `"`, then strips one layer of quotes or a single-line `"""…"""`. Wrapping every value in
 * `"""…"""` keeps `#`, quotes and spaces intact, as long as the value itself has an even number of `"` before its
 * first `#` (3 + even = odd, so flyctl does not cut). Other values are refused instead of being sent truncated.
 */
export function flySafe(value: string): boolean {
  const hash = value.indexOf("#");
  if (hash < 0) return true;
  return (value.slice(0, hash).split('"').length - 1) % 2 === 0;
}

export function encodeForFly(value: string): string {
  return `"""${value}"""`;
}

export function appFromFlyToml(text: string): string | null {
  return /^\s*app\s*=\s*['"]([^'"]+)['"]/m.exec(text)?.[1] ?? null;
}

/** Names from `fly secrets list --json`; tolerant of the field spelling (the docs do not fix it). */
export function namesFromSecretsList(json: string): string[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) return [];
  return data
    .map((e) => (e && typeof e === "object" ? ((e as Record<string, unknown>).Name ?? (e as Record<string, unknown>).name) : undefined))
    .filter((n): n is string => typeof n === "string");
}

export function resolveEnvFile(explicit: string | undefined, exists: (p: string) => boolean = existsSync): string | null {
  if (explicit) return exists(explicit) ? explicit : null;
  return [".env.local", ".env"].find((p) => exists(p)) ?? null;
}

export interface FlyRunner {
  (args: string[], stdin?: string): { status: number | null; stdout: string };
}

/** Runs flyctl. Only `secrets list` output is captured (parsed as JSON); everything else goes to the terminal. */
export const runFly: FlyRunner = (args, stdin) => {
  const bin = process.env.FLY_BIN ?? "fly";
  const capture = args[0] === "secrets" && args[1] === "list";
  const r = spawnSync(bin, args, {
    input: stdin,
    encoding: "utf8",
    stdio: [stdin === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
  });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status, stdout: r.stdout ?? "" };
};

export function syncArgs(app: string, stage: boolean): string[] {
  return ["secrets", "import", "--app", app, ...(stage ? ["--stage"] : [])];
}

export function unsetArgs(app: string, names: string[], stage: boolean): string[] {
  return ["secrets", "unset", "--app", app, ...(stage ? ["--stage"] : []), ...names];
}

/** Secrets that --prune never removes: set on fly by other means (docs/fly-deploy.md, accounts file as a secret file). */
export const PRUNE_KEEP: readonly string[] = ["ACCOUNTS_JSON"];

/** Remote names that --prune removes: everything not sent now and not kept. */
export function pruneCandidates(remote: string[], send: string[], keep: string[]): string[] {
  return remote.filter((n) => !send.includes(n) && !keep.includes(n) && !PRUNE_KEEP.includes(n) && NAME.test(n));
}

/** Asks on the terminal. Without a terminal there is nobody to ask, so the answer is no (use --force). */
export function confirmOnTty(question: string): boolean {
  // isatty(0), not process.stdin: touching process.stdin turns the terminal non-blocking and breaks readSync.
  if (!isatty(0)) return false;
  writeSync(1, `${question} [y/N] `);
  const buf = Buffer.alloc(64);
  let line = "";
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // no busy loop
        continue;
      }
      return false;
    }
    if (n === 0) break;
    line += buf.subarray(0, n).toString("utf8");
    if (line.includes("\n")) break;
  }
  return /^\s*(y|yes|j|ja)\s*$/i.test(line.split("\n")[0]);
}

function printPlan(plan: Plan, file: string, app: string, profile: Profile, log: (s: string) => void): void {
  log(`Quelle: ${file}   App: ${app}   Profil: ${profile}`);
  for (const spec of SECRETS) {
    const tag = plan.send.includes(spec.name) ? "senden " : plan.missingRequired.includes(spec.name) ? "FEHLT  " : plan.invalid.some((i) => i.name === spec.name) ? "UNGÜLTIG" : "leer   ";
    log(`  ${tag} ${spec.name}${spec.required || (profile === "prod" && spec.prodRequired) ? " (Pflicht)" : ""}: ${spec.purpose}`);
  }
  for (const i of plan.invalid) log(`  ! ${i.name}: ${i.reason}`);
  if (plan.config.length) log(`  übersprungen (steht in fly.toml [env]): ${plan.config.join(", ")}`);
  if (plan.unknown.length) log(`  übersprungen (nicht im Katalog): ${plan.unknown.join(", ")}`);
}

export interface MainDeps {
  run?: FlyRunner;
  log?: (s: string) => void;
  read?: (p: string) => string;
  exists?: (p: string) => boolean;
  confirm?: (question: string) => boolean;
  /** Process environment for --from-env (default: process.env). */
  env?: Record<string, string | undefined>;
}

const USAGE = "Aufruf: fly-secrets.ts check|status|sync [--env-file F | --from-env] [--app A] [--profile prod] [--stage] [--prune] [--keep A,B] [--force]";

/** Catalog values from the process environment, as a map the planner understands. Only catalog names are read. */
export function envFromProcess(source: Record<string, string | undefined>, catalog: readonly SecretSpec[] = SECRETS): Map<string, string> {
  const out = new Map<string, string>();
  for (const spec of catalog) {
    const v = source[spec.name];
    if (v !== undefined) out.set(spec.name, v);
  }
  return out;
}

export function main(argv: string[], deps: MainDeps = {}): number {
  const run = deps.run ?? runFly;
  const log = deps.log ?? ((s: string) => console.log(s));
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = deps.exists ?? existsSync;
  const confirm = deps.confirm ?? confirmOnTty;
  const [cmd = "check", ...rest] = argv;
  const opt = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!["check", "status", "sync"].includes(cmd)) {
    log(USAGE);
    return 2;
  }
  const stage = rest.includes("--stage");
  const prune = rest.includes("--prune");
  const force = rest.includes("--force");
  const keep = (opt("--keep") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (cmd !== "sync" && (stage || prune || force || keep.length)) {
    log("--stage, --prune, --keep und --force gibt es nur bei sync.");
    return 2;
  }
  const fromEnv = rest.includes("--from-env");
  const profileArg = opt("--profile");
  if (profileArg !== undefined && profileArg !== "prod" && profileArg !== "default") {
    log("--profile kennt nur prod oder default.");
    return 2;
  }
  const profile: Profile = profileArg === "prod" ? "prod" : "default";
  if (fromEnv && rest.includes("--env-file")) {
    log("--from-env und --env-file schließen sich aus.");
    return 2;
  }
  const file = fromEnv ? "Prozess-Umgebung (--from-env)" : resolveEnvFile(opt("--env-file"), exists);
  if (!file) {
    log("Keine Env-Datei gefunden (.env.local oder .env; Vorlage: .env.example).");
    return 1;
  }
  const app = opt("--app") ?? (exists("fly.toml") ? appFromFlyToml(read("fly.toml")) : null);
  if (!app) {
    log("Kein App-Name (fly.toml `app = ...` oder --app).");
    return 1;
  }
  let plan: Plan;
  try {
    plan = buildPlan(fromEnv ? envFromProcess(deps.env ?? process.env) : parseEnv(read(file)), SECRETS, profile);
  } catch (e) {
    log(e instanceof EnvParseError ? e.message : "env file unreadable");
    return 1;
  }
  printPlan(plan, file, app, profile, log);
  if (!plan.ok) {
    log("Abbruch: Pflicht-Secrets fehlen oder sind ungültig. Nichts gesendet.");
    return 1;
  }
  if (cmd === "check") {
    log(`OK: ${plan.send.length} Secret(s) bereit. Senden mit: make fly-secrets-sync`);
    return 0;
  }

  let remote: string[] = [];
  if (cmd === "status" || prune) {
    const r = run(["secrets", "list", "--app", app, "--json"]);
    if (r.status !== 0) {
      log("`fly secrets list` fehlgeschlagen (fly installiert? `fly auth login`?). Nichts geändert.");
      return 1;
    }
    try {
      remote = namesFromSecretsList(r.stdout);
    } catch {
      log("Antwort von `fly secrets list --json` nicht lesbar. Nichts geändert.");
      return 1;
    }
  }

  if (cmd === "status") {
    log(`  auf fly gesetzt: ${remote.length ? remote.join(", ") : "(keine)"}`);
    const notYet = plan.send.filter((n) => !remote.includes(n));
    if (notYet.length) log(`  noch nicht auf fly: ${notYet.join(", ")}`);
    const extra = pruneCandidates(remote, plan.send, []);
    if (extra.length) log(`  nur auf fly (würde --prune entfernen): ${extra.join(", ")}`);
    log("  (Werte werden nicht verglichen: fly zeigt nur Digests.)");
    return 0;
  }

  const remove = prune ? pruneCandidates(remote, plan.send, keep) : [];
  if (prune) {
    const kept = remote.filter((n) => !plan.send.includes(n) && !remove.includes(n));
    log(`  entfernen (--prune): ${remove.length ? remove.join(", ") : "(nichts)"}`);
    if (kept.length) log(`  behalten: ${kept.join(", ")}`);
  }
  const action = `${plan.send.length} setzen${remove.length ? `, ${remove.length} entfernen` : ""} auf ${app}${stage ? " (gestaged, ohne Neustart)" : " (Machine startet neu)"}`;
  if (!force && !confirm(`${action}?`)) {
    log("Abgebrochen, nichts geändert (ohne Terminal: --force bzw. FORCE=1).");
    return 1;
  }

  // With removals, stage the import so the Machine restarts only once (on the unset).
  const imp = run(syncArgs(app, stage || remove.length > 0), plan.stdin);
  if (imp.status !== 0) {
    log(imp.status === 127 ? "fly nicht gefunden (FLY_BIN oder PATH)." : "`fly secrets import` fehlgeschlagen. Nichts entfernt.");
    return 1;
  }
  log(`Gesendet: ${plan.send.join(", ")}`);
  if (remove.length) {
    const un = run(unsetArgs(app, remove, stage));
    if (un.status !== 0) {
      log("`fly secrets unset` fehlgeschlagen. Gesendete Secrets sind gestaged und wirken beim nächsten `fly deploy`.");
      return 1;
    }
    log(`Entfernt: ${remove.join(", ")}`);
  }
  if (stage) log("Gestaged: wirkt beim nächsten `fly deploy`.");
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
