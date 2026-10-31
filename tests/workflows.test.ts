import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p: string) => read(p).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

const SETUP_FLYCTL = /uses: superfly\/flyctl-actions\/setup-flyctl@[0-9a-f]{40} # 1\.6\n\s+with:\n\s+version: 0\.5\.1/;

test("secrets-to-fly: manual only, environment prod, read-only token, forced non-interactive from-env sync", () => {
  const y = code(".github/workflows/secrets-to-fly.yml");
  assert.match(y, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(y, /^\s+(push|pull_request|schedule):/m);
  assert.match(y, /^\s+environment: prod$/m);
  assert.match(y, /^permissions:\n  contents: read$/m);
  assert.match(y, /node scripts\/fly-secrets\.ts sync --from-env --profile prod --force/);
  assert.match(y, /node scripts\/fly-secrets\.ts sync --from-env --profile prod --stage --force/);
  assert.match(y, /type: boolean/);
  assert.match(y, SETUP_FLYCTL);
  assert.match(y, /node-version-file: \.nvmrc/);
});

test("secrets-to-fly: every catalog secret is mapped, values only via env, never echoed", () => {
  const y = code(".github/workflows/secrets-to-fly.yml");
  for (const n of ["FLY_API_TOKEN", "APP_PASSWORD", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ACCOUNTS_ENCRYPTION_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    assert.match(y, new RegExp(`^\\s+${n}: \\$\\{\\{ secrets\\.${n} \\}\\}$`, "m"), n);
  }
  const secretsUses = y.split("\n").filter((l) => /\$\{\{[^}]*secrets\./.test(l));
  assert.ok(secretsUses.every((l) => /^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/.test(l)), "secrets only as env mappings");
  assert.doesNotMatch(y, /\becho\b|\bprintenv\b|\benv\s*$|\bset -x\b|--debug|-v\b/m);
});

test("preview-app: manual, environment preview, deploy and destroy, guarded name, synthetic preview config", () => {
  const y = code(".github/workflows/preview-app.yml");
  assert.match(y, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(y, /^\s+(push|pull_request|schedule):/m);
  assert.match(y, /^\s+environment: preview$/m);
  assert.doesNotMatch(y, /environment: prod/);
  assert.match(y, /^permissions:\n  contents: read$/m);
  assert.match(y, /options: \[deploy, destroy\]/);
  assert.match(y, /FLY_APP=email-agent-preview-\$SUFFIX/);
  assert.match(y, /\*\[!a-z0-9-\]\*/);
  assert.match(y, /node scripts\/fly-secrets\.ts sync --from-env --app "\$FLY_APP" --stage --force/);
  assert.match(y, /fly deploy --app "\$FLY_APP" --config fly\.preview\.toml --remote-only/);
  assert.match(y, /fly apps destroy "\$FLY_APP" --yes/);
  assert.match(y, SETUP_FLYCTL);
});

test("preview-app: inputs reach shell only through env, secrets only as env mappings, only preview secrets", () => {
  const y = code(".github/workflows/preview-app.yml");
  const runs = y.split("\n").filter((l) => /^\s+(run:|- name:)/.test(l) || l.includes("fly ") || l.includes("node "));
  assert.ok(runs.every((l) => !l.includes("${{")), "no expression inside run lines");
  const secretsUses = y.split("\n").filter((l) => /\$\{\{[^}]*secrets\./.test(l));
  assert.ok(secretsUses.every((l) => /^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/.test(l)));
  assert.doesNotMatch(y, /ACCOUNTS_ENCRYPTION_KEY|VAPID|OPENAI_API_KEY/);
  assert.doesNotMatch(y, /\bfly (volumes|secrets set)\b/);
});

test("fly.preview.toml: synthetic only, no volume, no accounts file, secrets not in the file", () => {
  const t = code("fly.preview.toml");
  assert.match(t, /^\s*build-target = 'fly'$/m);
  assert.doesNotMatch(t, /\[mounts\]/);
  assert.doesNotMatch(t, /ACCOUNTS_FILE|APP_PASSWORD|OPENROUTER|ENCRYPTION|VAPID/);
  assert.match(t, /^\s*internal_port = 3000$/m);
  assert.match(t, /path = '\/api\/health'/);
});
