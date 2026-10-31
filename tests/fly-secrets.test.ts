import { test } from "node:test";
import assert from "node:assert/strict";
import { appFromFlyToml, buildPlan, encodeForFly, EnvParseError, flySafe, main, namesFromSecretsList, parseEnv, resolveEnvFile, syncArgs } from "../scripts/fly-secrets.ts";

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
  assert.deepEqual(plan.emptyOptional, ["OPENAI_API_KEY"]);
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

function harness(envText: string) {
  const out: string[] = [];
  const calls: { args: string[]; stdin?: string }[] = [];
  const files: Record<string, string> = { ".env.local": envText, "fly.toml": "app = 'email-agent'\n" };
  return {
    out,
    calls,
    deps: {
      log: (s: string) => out.push(s),
      read: (p: string) => files[p],
      exists: (p: string) => p in files,
      run: (args: string[], stdin?: string) => {
        calls.push({ args, stdin });
        return { status: 0, stdout: '[{"Name":"APP_PASSWORD"}]' };
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
