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

test("fly.toml: tailnet only (no public service), health check, Frankfurt, volume, no duplicate memory setting", () => {
  const raw = read("fly.toml");
  const t = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(t, /^primary_region = 'fra'$/m);
  // ADR 0046: no [http_service] and no [[services]] = no route through fly's public proxy.
  assert.doesNotMatch(t, /^\[http_service\]|^\[\[services\]\]/m);
  assert.match(t, /^\s*TAILSCALE_ENABLE = '1'$/m);
  assert.match(t, /^\s*TS_HOSTNAME = '[a-z0-9-]+'$/m);
  assert.match(t, /^\[checks\]$/m);
  assert.match(t, /^\s*port = 3000$/m);
  assert.doesNotMatch(t, /TS_AUTHKEY/);
  assert.match(t, /^\s*build-target = 'fly'$/m);
  assert.match(t, /source = 'email_data'/);
  assert.match(t, /destination = '\/data'/);
  assert.match(t, /path = '\/api\/health'/);
  assert.equal((t.match(/memory/g) ?? []).length, 1);
  assert.doesNotMatch(t, /APP_PASSWORD|OPENROUTER_API_KEY|ACCOUNTS/);
  assert.match(t, /^\s*AUTH_MODE = 'users'$/m, "fly runs in users mode (docs/access-contract.md)");
});

test("entrypoint: tailscale only on TAILSCALE_ENABLE=1, userspace as node, key via file and never printed, unset before the app", () => {
  const s = read("scripts/docker-entrypoint.sh");
  assert.match(s, /if \[ "\$\{TAILSCALE_ENABLE:-\}" = "1" \]; then start_tailscale 1; fi/);
  assert.match(s, /tailscaled --tun=userspace-networking --statedir=/);
  assert.match(s, /setpriv --reuid=node --regid=node --init-groups -- "\$@"; else/);
  assert.match(s, /--auth-key="file:\$keyfile"/);
  assert.match(s, /rm -f "\$keyfile"/);
  assert.match(s, /unset TS_AUTHKEY/);
  assert.match(s, /serve --bg --https=443 "http:\/\/127\.0\.0\.1:/);
  // The key must never reach stdout/stderr or argv.
  for (const line of s.split("\n")) {
    if (/\becho\b/.test(line)) assert.doesNotMatch(line, /\$\{?TS_AUTHKEY/, line);
  }
  assert.doesNotMatch(s, /--auth-key="\$TS_AUTHKEY"/);
});

test("Dockerfile: tailscale binaries only in the fly target, pinned by version and digest", () => {
  const stages = read("Dockerfile").split(/^FROM /m).slice(1);
  assert.match(stages[1] ?? "", /tailscale\/tailscale:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64} \/usr\/local\/bin\/tailscaled/);
  assert.doesNotMatch(stages[0] ?? "", /tailscale/);
  assert.doesNotMatch(stages[2] ?? "", /tailscale/);
});
