import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// The root branch (chown, setpriv) is proven by the Docker probe in docs/fly-deploy.md; here only what runs anywhere.
test("entrypoint as an unprivileged user runs the command unchanged", { skip: process.getuid?.() === 0 }, () => {
  const r = spawnSync("sh", ["scripts/docker-entrypoint.sh", "sh", "-c", "echo \"$0:$1\"", "a", "b"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "a:b");
});

test("entrypoint script has the root-only guard, drops privileges permanently and refuses system directories", () => {
  const s = read("scripts/docker-entrypoint.sh");
  assert.match(s, /\[ "\$\(id -u\)" = "0" \]/);
  assert.match(s, /exec setpriv --reuid=node --regid=node --init-groups/);
  assert.match(s, /refusing to change ownership/);
});

test("Dockerfile: default (last) target keeps USER node, the fly target has no USER", () => {
  const stages = read("Dockerfile").split(/^FROM /m).slice(1);
  const names = stages.map((b) => /\bAS (\w+)/.exec(b.split("\n")[0] ?? "")?.[1]);
  assert.deepEqual(names, ["base", "fly", "app"]);
  assert.match(stages[2] ?? "", /^USER node$/m);
  assert.doesNotMatch(stages[0] ?? "", /^USER /m);
  assert.doesNotMatch(stages[1] ?? "", /^USER /m);
  assert.match(read("Dockerfile"), /ENTRYPOINT \["sh", "\/app\/scripts\/docker-entrypoint\.sh"\]/);
});

test("fly.toml: one machine, always on, Frankfurt, port 3000, volume, no duplicate memory setting", () => {
  const raw = read("fly.toml");
  const t = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(t, /^primary_region = 'fra'$/m);
  assert.match(t, /^\s*internal_port = 3000$/m);
  assert.match(t, /^\s*auto_stop_machines = 'off'$/m);
  assert.match(t, /^\s*min_machines_running = 1$/m);
  assert.match(t, /^\s*force_https = true$/m);
  assert.match(t, /^\s*build-target = 'fly'$/m);
  assert.match(t, /source = 'email_data'/);
  assert.match(t, /destination = '\/data'/);
  assert.match(t, /path = '\/api\/health'/);
  assert.equal((t.match(/memory/g) ?? []).length, 1);
  assert.doesNotMatch(t, /APP_PASSWORD|OPENROUTER_API_KEY|ACCOUNTS/);
  assert.match(t, /^\s*AUTH_MODE = 'users'$/m, "fly runs in users mode (docs/access-contract.md)");
});
