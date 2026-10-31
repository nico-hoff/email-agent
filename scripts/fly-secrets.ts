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
//   node scripts/fly-secrets.ts sync [--env-file F] [--app A] [--stage]   send to fly (`--stage`: no restart)
// Makefile: make fly-secrets-check | fly-secrets-status | fly-secrets-sync | fly-secrets-stage
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appPasswordStatus } from "../lib/auth.ts";

export interface SecretSpec {
  name: string;
  required: boolean;
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
];

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

export function buildPlan(env: Map<string, string>, catalog: readonly SecretSpec[] = SECRETS): Plan {
  const send: string[] = [];
  const missingRequired: string[] = [];
  const invalid: { name: string; reason: string }[] = [];
  const emptyOptional: string[] = [];
  const lines: string[] = [];
  for (const spec of catalog) {
    const value = env.get(spec.name) ?? "";
    if (value === "") {
      (spec.required ? missingRequired : emptyOptional).push(spec.name);
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

/** Runs flyctl. stdout is only captured when no stdin is given (list); otherwise output goes to the terminal. */
export const runFly: FlyRunner = (args, stdin) => {
  const bin = process.env.FLY_BIN ?? "fly";
  const r = spawnSync(bin, args, {
    input: stdin,
    encoding: "utf8",
    stdio: [stdin === undefined ? "inherit" : "pipe", stdin === undefined ? "pipe" : "inherit", "inherit"],
  });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status, stdout: r.stdout ?? "" };
};

export function syncArgs(app: string, stage: boolean): string[] {
  return ["secrets", "import", "--app", app, ...(stage ? ["--stage"] : [])];
}

function printPlan(plan: Plan, file: string, app: string, log: (s: string) => void): void {
  log(`Quelle: ${file}   App: ${app}`);
  for (const spec of SECRETS) {
    const tag = plan.send.includes(spec.name) ? "senden " : plan.missingRequired.includes(spec.name) ? "FEHLT  " : plan.invalid.some((i) => i.name === spec.name) ? "UNGÜLTIG" : "leer   ";
    log(`  ${tag} ${spec.name}${spec.required ? " (Pflicht)" : ""}: ${spec.purpose}`);
  }
  for (const i of plan.invalid) log(`  ! ${i.name}: ${i.reason}`);
  if (plan.config.length) log(`  übersprungen (steht in fly.toml [env]): ${plan.config.join(", ")}`);
  if (plan.unknown.length) log(`  übersprungen (nicht im Katalog): ${plan.unknown.join(", ")}`);
}

export function main(argv: string[], deps: { run?: FlyRunner; log?: (s: string) => void; read?: (p: string) => string; exists?: (p: string) => boolean } = {}): number {
  const run = deps.run ?? runFly;
  const log = deps.log ?? ((s: string) => console.log(s));
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = deps.exists ?? existsSync;
  const [cmd = "check", ...rest] = argv;
  const opt = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!["check", "status", "sync"].includes(cmd)) {
    log("Aufruf: fly-secrets.ts check|status|sync [--env-file F] [--app A] [--stage]");
    return 2;
  }
  const file = resolveEnvFile(opt("--env-file"), exists);
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
    plan = buildPlan(parseEnv(read(file)));
  } catch (e) {
    log(e instanceof EnvParseError ? e.message : "env file unreadable");
    return 1;
  }
  printPlan(plan, file, app, log);
  if (!plan.ok) {
    log("Abbruch: Pflicht-Secrets fehlen oder sind ungültig. Nichts gesendet.");
    return 1;
  }

  if (cmd === "status") {
    const r = run(["secrets", "list", "--app", app, "--json"]);
    if (r.status !== 0) {
      log("`fly secrets list` fehlgeschlagen (fly installiert? `fly auth login`?).");
      return 1;
    }
    let remote: string[];
    try {
      remote = namesFromSecretsList(r.stdout);
    } catch {
      log("Antwort von `fly secrets list --json` nicht lesbar.");
      return 1;
    }
    log(`  auf fly gesetzt: ${remote.length ? remote.join(", ") : "(keine)"}`);
    const notYet = plan.send.filter((n) => !remote.includes(n));
    if (notYet.length) log(`  noch nicht auf fly: ${notYet.join(", ")}`);
    const extra = remote.filter((n) => !SECRETS.some((s) => s.name === n));
    if (extra.length) log(`  nur auf fly (nicht im Katalog, bleibt unangetastet): ${extra.join(", ")}`);
    log("  (Werte werden nicht verglichen: fly zeigt nur Digests.)");
    return 0;
  }
  if (cmd === "check") {
    log(`OK: ${plan.send.length} Secret(s) bereit. Senden mit: make fly-secrets-sync`);
    return 0;
  }
  const stage = rest.includes("--stage");
  const r = run(syncArgs(app, stage), plan.stdin);
  if (r.status !== 0) {
    log(r.status === 127 ? "fly nicht gefunden (FLY_BIN oder PATH)." : "`fly secrets import` fehlgeschlagen.");
    return 1;
  }
  log(`Gesendet: ${plan.send.join(", ")}${stage ? " (gestaged, wirkt beim nächsten `fly deploy`)" : ""}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
