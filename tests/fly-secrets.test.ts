import { test } from "node:test";
import assert from "node:assert/strict";
import { appFromFlyToml, base64Bytes, buildPlan, envFromProcess, encodeForFly, EnvParseError, flySafe, main, namesFromSecretsList, parseEnv, pruneCandidates, resolveEnvFile, syncArgs, unsetArgs } from "../scripts/fly-secrets.ts";

// Synthetic values only.
const PW = "synthetic-test-passphrase-0123";
const KEY = "sk-or-synthetic-0000";

test("parseEnv: comments, export, quotes, inline comments", () => {
  const env = parseEnv(`# comment\n\nexport A=1\nB="two words"\nC='x#y'\nD=plain # note\nE=\n`);
  assert.deepEqual([...env], [["A", "1"], ["B", "two words"], ["C", "x#y"], ["D", "plain"], ["E", ""]]);
});

test("parseEnv: errors name the line, never the content", () => {
  assert.throws(() => parseEnv(`OK=1\nAPP_PASSWORD="${PW}`), (e: unknown) => e instanceof EnvParseError && e.message.includes("line 2") && !e.message.includes(PW));
  assert.throws(() => parseEnv("no equals sign"), EnvParseError);
  assert.throws(() => parseEnv("1BAD=x"), EnvParseError);
});

test("buildPlan: sends only catalog secrets, skips config and unknown names", () => {
  const plan = buildPlan(parseEnv(`APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=${KEY}\nBIND_ADDRESS=127.0.0.1\nDATABASE_PATH=data/x.sqlite\nIMAP_SOMETHING=zzz\n`));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.send, ["APP_PASSWORD", "OPENROUTER_API_KEY"]);
  assert.deepEqual(plan.emptyOptional, ["OPENAI_API_KEY", "ACCOUNTS_ENCRYPTION_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  assert.deepEqual(plan.config, ["BIND_ADDRESS", "DATABASE_PATH"]);
  assert.deepEqual(plan.unknown, ["IMAP_SOMETHING"]);
  assert.equal(plan.stdin, `APP_PASSWORD="""${PW}"""\nOPENROUTER_API_KEY="""${KEY}"""\n`);
  assert.ok(!plan.stdin.includes("zzz") && !plan.stdin.includes("127.0.0.1"));
});

test("buildPlan: missing, short and placeholder values block the sync", () => {
  const missing = buildPlan(parseEnv(`OPENROUTER_API_KEY=${KEY}\n`));
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingRequired, ["APP_PASSWORD"]);
  assert.equal(missing.stdin, "");
  const short = buildPlan(parseEnv(`APP_PASSWORD=short\nOPENROUTER_API_KEY=${KEY}\n`));
  assert.deepEqual(short.invalid.map((i) => i.name), ["APP_PASSWORD"]);
  const placeholder = buildPlan(parseEnv(`APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=sk-or-REPLACE_ME\n`));
  assert.deepEqual(placeholder.invalid.map((i) => i.name), ["OPENROUTER_API_KEY"]);
  assert.equal(placeholder.ok, false);
});

test("helpers: fly.toml app, secrets list names, env file resolution, args", () => {
  assert.equal(appFromFlyToml("# x\napp = 'email-agent'\nprimary_region = 'fra'\n"), "email-agent");
  assert.equal(appFromFlyToml("primary_region = 'fra'\n"), null);
  assert.deepEqual(namesFromSecretsList('[{"Name":"A","Digest":"d"},{"name":"B"},{"x":1}]'), ["A", "B"]);
  assert.deepEqual(namesFromSecretsList("{}"), []);
  assert.equal(resolveEnvFile(undefined, (p) => p === ".env"), ".env");
  assert.equal(resolveEnvFile(undefined, () => true), ".env.local");
  assert.equal(resolveEnvFile("custom.env", () => false), null);
  assert.deepEqual(syncArgs("a", true), ["secrets", "import", "--app", "a", "--stage"]);
});

function harness(envText: string, o: { remote?: string; confirm?: boolean } = {}) {
  const out: string[] = [];
  const calls: { args: string[]; stdin?: string }[] = [];
  const questions: string[] = [];
  const files: Record<string, string> = { ".env.local": envText, "fly.toml": "app = 'email-agent'\n" };
  return {
    out,
    calls,
    questions,
    deps: {
      confirm: (q: string) => {
        questions.push(q);
        return o.confirm ?? true;
      },
      log: (s: string) => out.push(s),
      read: (p: string) => files[p],
      exists: (p: string) => p in files,
      run: (args: string[], stdin?: string) => {
        calls.push({ args, stdin });
        return { status: 0, stdout: o.remote ?? '[{"Name":"APP_PASSWORD"}]' };
      },
    },
  };
}

test("main sync: values only on stdin, never in argv or output", () => {
  const h = harness(`APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.equal(main(["sync"], h.deps), 0);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, ["secrets", "import", "--app", "email-agent"]);
  assert.equal(h.calls[0].stdin, `APP_PASSWORD="""${PW}"""\nOPENROUTER_API_KEY="""${KEY}"""\n`);
  const all = h.out.join("\n") + h.calls[0].args.join(" ");
  assert.ok(!all.includes(PW) && !all.includes(KEY));
});

test("main check: contacts nothing; invalid plan never calls fly", () => {
  const ok = harness(`APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.equal(main(["check"], ok.deps), 0);
  assert.equal(ok.calls.length, 0);
  const bad = harness(`APP_PASSWORD=short\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.equal(main(["sync"], bad.deps), 1);
  assert.equal(bad.calls.length, 0);
  assert.ok(!bad.out.join("\n").includes("short\n") && !bad.out.join("\n").includes(KEY));
});

test("main status: compares names with fly secrets list", () => {
  const h = harness(`APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.equal(main(["status"], h.deps), 0);
  assert.deepEqual(h.calls[0].args, ["secrets", "list", "--app", "email-agent", "--json"]);
  assert.equal(h.calls[0].stdin, undefined);
  assert.ok(h.out.some((l) => l.includes("noch nicht auf fly: OPENROUTER_API_KEY")));
  assert.equal(h.questions.length, 0);
});

test("main: --app overrides fly.toml, unknown command is refused", () => {
  const h = harness(`APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.equal(main(["sync", "--app", "other", "--stage"], h.deps), 0);
  assert.deepEqual(h.calls[0].args, ["secrets", "import", "--app", "other", "--stage"]);
  assert.equal(main(["push"], h.deps), 2);
});

/** Port of the single-line path of flyctl's secrets parser (internal/command/secrets/parser.go), for round-trip checks. */
function flyctlParseLine(line: string): [string, string] {
  const eq = line.indexOf("=");
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).replace(/^ +/, "");
  const hash = value.indexOf("#");
  if (hash >= 0 && (value.slice(0, hash).split('"').length - 1) % 2 === 0) value = value.slice(0, hash).replace(/ +$/, "");
  if (value.startsWith('"""') && value.endsWith('"""') && value.length >= 6) return [key, value.slice(3, -3)];
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  return [key, value];
}

test("encodeForFly: tricky values arrive unchanged at flyctl", () => {
  const values = ["plain", "with#hash", "a b # c", "  spaced  ", '"quoted"', "'single'", 'x"y"#z', "=eq=", '"', "'", "ends\\"];
  for (const v of values) {
    assert.ok(flySafe(v), v);
    assert.deepEqual(flyctlParseLine(`K=${encodeForFly(v)}`), ["K", v]);
  }
  assert.equal(flySafe('a"b#c'), false);
  const plan = buildPlan(parseEnv(`APP_PASSWORD='odd"quote#before-hash-xx'\nOPENROUTER_API_KEY=${KEY}\n`));
  assert.deepEqual(plan.invalid.map((i) => i.name), ["APP_PASSWORD"]);
});

const OK_ENV = `APP_PASSWORD=${PW}\nOPENROUTER_API_KEY=${KEY}\n`;
const REMOTE = '[{"Name":"APP_PASSWORD"},{"Name":"OLD_TOKEN"},{"Name":"OPENAI_API_KEY"},{"Name":"ACCOUNTS_JSON"},{"Name":"KEEP_ME"}]';

test("pruneCandidates and unsetArgs", () => {
  assert.deepEqual(pruneCandidates(["A", "B", "ACCOUNTS_JSON", "C", "bad name"], ["A"], ["C"]), ["B"]);
  assert.deepEqual(unsetArgs("app", ["X", "Y"], true), ["secrets", "unset", "--app", "app", "--stage", "X", "Y"]);
});

test("sync asks first; declined means fly is not touched", () => {
  const h = harness(OK_ENV, { confirm: false });
  assert.equal(main(["sync"], h.deps), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.questions.length, 1);
});

test("--force skips the question but never the validation", () => {
  const ok = harness(OK_ENV, { confirm: false });
  assert.equal(main(["sync", "--force"], ok.deps), 0);
  assert.equal(ok.questions.length, 0);
  assert.equal(ok.calls.length, 1);
  const bad = harness(`APP_PASSWORD=short\nOPENROUTER_API_KEY=${KEY}\n`);
  assert.equal(main(["sync", "--force"], bad.deps), 1);
  assert.equal(bad.calls.length, 0);
});

test("--prune: import staged, then one unset of everything not sent; ACCOUNTS_JSON and --keep survive", () => {
  const h = harness(OK_ENV, { remote: REMOTE });
  assert.equal(main(["sync", "--prune", "--keep", "KEEP_ME", "--force"], h.deps), 0);
  assert.deepEqual(h.calls.map((c) => c.args), [
    ["secrets", "list", "--app", "email-agent", "--json"],
    ["secrets", "import", "--app", "email-agent", "--stage"],
    ["secrets", "unset", "--app", "email-agent", "OLD_TOKEN", "OPENAI_API_KEY"],
  ]);
  assert.equal(h.calls[2].stdin, undefined);
  assert.ok(!h.out.join("\n").includes(PW));
});

test("--prune --stage stages the unset too; nothing to remove means a plain import", () => {
  const staged = harness(OK_ENV, { remote: REMOTE });
  assert.equal(main(["sync", "--prune", "--stage", "--force"], staged.deps), 0);
  assert.deepEqual(staged.calls[2].args, ["secrets", "unset", "--app", "email-agent", "--stage", "OLD_TOKEN", "OPENAI_API_KEY", "KEEP_ME"]);
  const none = harness(OK_ENV, { remote: '[{"Name":"APP_PASSWORD"},{"Name":"OPENROUTER_API_KEY"}]' });
  assert.equal(main(["sync", "--prune", "--force"], none.deps), 0);
  assert.deepEqual(none.calls.map((c) => c.args[1]), ["list", "import"]);
  assert.deepEqual(none.calls[1].args, ["secrets", "import", "--app", "email-agent"]);
});

test("--prune: failed list or import changes nothing further", () => {
  const h = harness(OK_ENV);
  h.deps.run = (args: string[], stdin?: string) => {
    h.calls.push({ args, stdin });
    return { status: 1, stdout: "" };
  };
  assert.equal(main(["sync", "--prune", "--force"], h.deps), 1);
  assert.equal(h.calls.length, 1);
  const imp = harness(OK_ENV, { remote: REMOTE });
  const run = imp.deps.run;
  imp.deps.run = (args: string[], stdin?: string) => (args[1] === "import" ? (imp.calls.push({ args, stdin }), { status: 1, stdout: "" }) : run(args, stdin));
  assert.equal(main(["sync", "--prune", "--force"], imp.deps), 1);
  assert.ok(!imp.calls.some((c) => c.args[1] === "unset"));
});

test("sync-only flags are refused elsewhere", () => {
  const h = harness(OK_ENV);
  assert.equal(main(["check", "--prune"], h.deps), 2);
  assert.equal(main(["status", "--force"], h.deps), 2);
  assert.equal(h.calls.length, 0);
});

// New catalog entries (R4). Synthetic values only: random-looking but fixed.
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");
const VAPID_PUB = Buffer.alloc(65, 4).toString("base64url");
const VAPID_PRIV = Buffer.alloc(32, 5).toString("base64url");
const PROD_ENV = `${OK_ENV}ACCOUNTS_ENCRYPTION_KEY=${ENC_KEY}\nVAPID_PUBLIC_KEY=${VAPID_PUB}\nVAPID_PRIVATE_KEY=${VAPID_PRIV}\nVAPID_SUBJECT=mailto:ops@example.test\n`;

test("base64Bytes: counts decoded bytes, refuses malformed input", () => {
  assert.equal(base64Bytes(ENC_KEY, false), 32);
  assert.equal(base64Bytes(VAPID_PUB, true), 65);
  assert.equal(base64Bytes("not base64!", false), null);
  assert.equal(base64Bytes("-_-_", false), null);
  assert.equal(base64Bytes("AAA", false), null); // bad padding
});

test("ACCOUNTS_ENCRYPTION_KEY: 32 bytes base64 or refused without echoing the value", () => {
  const short = Buffer.alloc(16, 1).toString("base64");
  const plan = buildPlan(parseEnv(`${OK_ENV}ACCOUNTS_ENCRYPTION_KEY=${short}\n`));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.invalid.map((i) => i.name), ["ACCOUNTS_ENCRYPTION_KEY"]);
  assert.ok(!JSON.stringify(plan.invalid).includes(short));
  assert.equal(buildPlan(parseEnv(`${OK_ENV}ACCOUNTS_ENCRYPTION_KEY=${ENC_KEY}\n`)).ok, true);
});

test("VAPID values are validated; subject must be mailto: or https://", () => {
  const bad = buildPlan(parseEnv(`${PROD_ENV}VAPID_PRIVATE_KEY=short\n`));
  assert.deepEqual(bad.invalid.map((i) => i.name), ["VAPID_PRIVATE_KEY"]);
  const subj = buildPlan(parseEnv(`${OK_ENV}VAPID_SUBJECT=ops@example.test\n`));
  assert.deepEqual(subj.invalid.map((i) => i.name), ["VAPID_SUBJECT"]);
  assert.equal(buildPlan(parseEnv(`${OK_ENV}VAPID_SUBJECT=https://example.test/contact\n`)).ok, true);
});

test("profile prod: encryption key and VAPID keys are required, subject stays optional; default profile needs none", () => {
  assert.equal(buildPlan(parseEnv(OK_ENV)).ok, true);
  const prod = buildPlan(parseEnv(OK_ENV), undefined, "prod");
  assert.equal(prod.ok, false);
  assert.deepEqual(prod.missingRequired, ["ACCOUNTS_ENCRYPTION_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]);
  assert.ok(prod.emptyOptional.includes("VAPID_SUBJECT"));
  const full = buildPlan(parseEnv(PROD_ENV), undefined, "prod");
  assert.equal(full.ok, true);
  assert.equal(full.send.length, 6);
});

test("envFromProcess reads catalog names only", () => {
  const m = envFromProcess({ APP_PASSWORD: PW, PATH: "/usr/bin", GITHUB_TOKEN: "zzz", VAPID_SUBJECT: undefined });
  assert.deepEqual([...m], [["APP_PASSWORD", PW]]);
});

function fromEnvHarness(env: Record<string, string | undefined>) {
  const h = harness("SHOULD_NOT_BE_READ=1\n");
  const read = (p: string) => {
    if (p !== "fly.toml") throw new Error("env file must not be read with --from-env");
    return "app = 'email-agent'\n";
  };
  return { ...h, deps: { ...h.deps, env, read } };
}

test("--from-env sync: values from the environment go only to stdin, no env file is read", () => {
  const h = fromEnvHarness({ APP_PASSWORD: PW, OPENROUTER_API_KEY: KEY, ACCOUNTS_ENCRYPTION_KEY: ENC_KEY, VAPID_PUBLIC_KEY: VAPID_PUB, VAPID_PRIVATE_KEY: VAPID_PRIV, VAPID_SUBJECT: "", OPENAI_API_KEY: "", GITHUB_TOKEN: "zzz" });
  assert.equal(main(["sync", "--from-env", "--profile", "prod", "--force"], h.deps), 0);
  assert.equal(h.questions.length, 0);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, ["secrets", "import", "--app", "email-agent"]);
  const stdin = h.calls[0].stdin ?? "";
  for (const v of [PW, KEY, ENC_KEY, VAPID_PUB, VAPID_PRIV]) assert.ok(stdin.includes(v));
  assert.ok(!stdin.includes("zzz") && !stdin.includes("VAPID_SUBJECT"));
  const visible = h.out.join("\n") + h.calls[0].args.join(" ");
  for (const v of [PW, KEY, ENC_KEY, VAPID_PUB, VAPID_PRIV, "zzz"]) assert.ok(!visible.includes(v));
  assert.ok(h.out.some((l) => l.includes("Prozess-Umgebung") && l.includes("Profil: prod")));
});

test("--from-env --stage: staged import; empty secrets of the environment count as missing", () => {
  const ok = fromEnvHarness({ APP_PASSWORD: PW, OPENROUTER_API_KEY: KEY });
  assert.equal(main(["sync", "--from-env", "--stage", "--force"], ok.deps), 0);
  assert.deepEqual(ok.calls[0].args, ["secrets", "import", "--app", "email-agent", "--stage"]);
  const missing = fromEnvHarness({ APP_PASSWORD: PW, OPENROUTER_API_KEY: "" });
  assert.equal(main(["sync", "--from-env", "--force"], missing.deps), 1);
  assert.equal(missing.calls.length, 0);
  const prodMissing = fromEnvHarness({ APP_PASSWORD: PW, OPENROUTER_API_KEY: KEY });
  assert.equal(main(["sync", "--from-env", "--profile", "prod", "--force"], prodMissing.deps), 1);
  assert.equal(prodMissing.calls.length, 0);
  assert.ok(prodMissing.out.some((l) => l.includes("FEHLT") && l.includes("ACCOUNTS_ENCRYPTION_KEY")));
});

test("--from-env without --force and without a terminal: asks, declined means fly is not touched", () => {
  const h = fromEnvHarness({ APP_PASSWORD: PW, OPENROUTER_API_KEY: KEY });
  h.deps.confirm = (q: string) => (h.questions.push(q), false);
  assert.equal(main(["sync", "--from-env"], h.deps), 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.questions.length, 1);
});

test("--from-env: --app, conflicting and unknown options", () => {
  const h = fromEnvHarness({ APP_PASSWORD: PW, OPENROUTER_API_KEY: KEY });
  assert.equal(main(["sync", "--from-env", "--app", "email-agent-preview-x", "--stage", "--force"], h.deps), 0);
  assert.deepEqual(h.calls[0].args, ["secrets", "import", "--app", "email-agent-preview-x", "--stage"]);
  assert.equal(main(["sync", "--from-env", "--env-file", "x.env", "--force"], h.deps), 2);
  assert.equal(main(["check", "--profile", "weird"], h.deps), 2);
  assert.equal(h.calls.length, 1);
});
