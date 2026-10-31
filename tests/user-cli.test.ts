import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";
import { listOpenInvites, registerWithInvite, verifyLogin } from "../lib/users.ts";
import { parseUserCreateArgs, userCreateMain } from "../scripts/user-create.ts";
import { parseUserInviteArgs, userInviteMain } from "../scripts/user-invite.ts";

const PW = "cli-MARKER-9d2f4e11-password";

function env(): { env: Record<string, string>; file: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "usercli-"));
  chmodSync(root, 0o700);
  const file = join(root, "t.sqlite");
  return { env: { DATABASE_PATH: file }, file, root };
}
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("user:create arguments", () => {
  it("email is required; role defaults to admin; unknown arguments and any password argument are refused", () => {
    assert.deepEqual(parseUserCreateArgs(["--email", "a@x.test"]), { email: "a@x.test", role: "admin", passwordStdin: false });
    assert.deepEqual(parseUserCreateArgs(["--email", "a@x.test", "--role", "user", "--password-stdin"]), { email: "a@x.test", role: "user", passwordStdin: true });
    for (const bad of [[], ["--email"], ["--email", "a@x.test", "--role", "root"], ["--email", "a@x.test", "--bogus"], ["--email", "a@x.test", "--password", "x"], ["--email", "a@x.test", "--password=x"], ["positional"]]) {
      assert.ok("error" in parseUserCreateArgs(bad), JSON.stringify(bad));
    }
    const refused = parseUserCreateArgs(["--email", "a@x.test", "--password", PW]) as { error: string };
    assert.ok(!refused.error.includes(PW), "the error never repeats the secret");
  });
});

describe("user:create", () => {
  it("password from stdin: the first admin claims the owner row; the password is never printed", async () => {
    const t = env();
    const c = capture();
    const code = await userCreateMain(["--email", "nico@x.test", "--password-stdin"], { env: t.env, readStdin: async () => `${PW}\n`, ...c.io });
    assert.equal(code, 0);
    assert.match(c.out[0], /^user:create ok: id=1 role=admin \(claimed the owner row/);
    assert.ok(!c.out.join("\n").includes(PW) && !c.out.join("\n").includes("nico@x.test"));
    const db = openDatabase(t.file);
    try {
      assert.equal((await verifyLogin(db, "nico@x.test", PW))?.id, 1);
    } finally {
      db.close();
    }
  });

  it("a second call adds a new user with the chosen role", async () => {
    const t = env();
    const c = capture();
    await userCreateMain(["--email", "a@x.test", "--password-stdin"], { env: t.env, readStdin: async () => PW, ...c.io });
    assert.equal(await userCreateMain(["--email", "b@x.test", "--role", "user", "--password-stdin"], { env: t.env, readStdin: async () => `${PW}\r\n`, ...c.io }), 0);
    assert.match(c.out[1], /^user:create ok: id=2 role=user$/);
  });

  it("refusals have exit code 1 and a plain reason: short password, bad email, taken email", async () => {
    const t = env();
    const run = (email: string, pw: string) => {
      const c = capture();
      return userCreateMain(["--email", email, "--password-stdin"], { env: t.env, readStdin: async () => pw, ...c.io }).then((code) => ({ code, err: c.err.join("\n") }));
    };
    assert.deepEqual(await run("a@x.test", "short"), { code: 1, err: "user:create: password too short (minimum 12 characters)" });
    assert.deepEqual(await run("nope", PW), { code: 1, err: "user:create: invalid email address" });
    assert.equal((await run("a@x.test", PW)).code, 0);
    assert.deepEqual(await run("A@x.test", PW), { code: 1, err: "user:create: email address already registered" });
  });

  it("interactive prompt: asked twice, a mismatch is refused; without a terminal and without --password-stdin it stops", async () => {
    const t = env();
    const answers = [PW, PW];
    const c = capture();
    assert.equal(await userCreateMain(["--email", "a@x.test"], { env: t.env, isTty: true, promptPassword: async () => answers.shift()!, ...c.io }), 0);
    const mism = [PW, PW + "x"];
    const d = capture();
    assert.equal(await userCreateMain(["--email", "b@x.test"], { env: t.env, isTty: true, promptPassword: async () => mism.shift()!, ...d.io }), 1);
    const e = capture();
    assert.equal(await userCreateMain(["--email", "b@x.test"], { env: t.env, isTty: false, ...e.io }), 2);
    assert.match(e.err[0], /--password-stdin/);
  });

  it("a rejected DATABASE_PATH parent (group-readable) stops before any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "usercli-open-"));
    chmodSync(root, 0o755);
    const c = capture();
    await assert.rejects(userCreateMain(["--email", "a@x.test", "--password-stdin"], { env: { DATABASE_PATH: join(root, "t.sqlite") }, readStdin: async () => PW, ...c.io }), /DATABASE_PATH/);
  });

  it("end to end as a real process: password piped on stdin, npm-style arguments, nothing printed but the id", () => {
    const t = env();
    const r = spawnSync(process.execPath, ["scripts/user-create.ts", "--email", "proc@x.test", "--password-stdin"], {
      cwd: join(import.meta.dirname, ".."), env: { ...process.env, DATABASE_PATH: t.file }, input: `${PW}\n`, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /user:create ok: id=1 role=admin/);
    assert.ok(!r.stdout.includes(PW) && !r.stderr.includes(PW));
    const none = spawnSync(process.execPath, ["scripts/user-create.ts", "--email", "x@x.test"], {
      cwd: join(import.meta.dirname, ".."), env: { ...process.env, DATABASE_PATH: t.file }, input: "", encoding: "utf8",
    });
    assert.equal(none.status, 2);
  });
});

describe("user:invite", () => {
  it("arguments: role user by default, 7 days, bounds enforced", () => {
    assert.deepEqual(parseUserInviteArgs([]), { role: "user", days: 7, by: undefined });
    assert.deepEqual(parseUserInviteArgs(["--role", "admin", "--days", "14", "--by", "a@x.test"]), { role: "admin", days: 14, by: "a@x.test" });
    for (const bad of [["--role", "root"], ["--days", "0"], ["--days", "31"], ["--days", "x"], ["--nope"]]) assert.ok("error" in parseUserInviteArgs(bad), JSON.stringify(bad));
  });

  it("needs an admin; prints the code once; only the hash is stored; the code registers a user", async () => {
    const t = env();
    const none = capture();
    assert.equal(await userInviteMain([], { env: t.env, ...none.io }), 1);
    assert.match(none.err[0], /no active admin/);
    await userCreateMain(["--email", "admin@x.test", "--password-stdin"], { env: t.env, readStdin: async () => PW, ...capture().io });
    const c = capture();
    const now = new Date("2026-10-31T10:00:00.000Z");
    assert.equal(await userInviteMain(["--days", "2"], { env: t.env, ...c.io }, now), 0);
    const code = /: ([A-Z2-9-]{24})$/.exec(c.out[0])?.[1];
    assert.ok(code, c.out[0]);
    assert.match(c.out[1], /^Rolle: user, gültig bis 2026-11-02T10:00:00\.000Z$/);
    const db = openDatabase(t.file);
    try {
      assert.ok(!JSON.stringify(db.prepare("SELECT * FROM invites").all()).includes(code));
      assert.equal(listOpenInvites(db, now).length, 1);
      const r = await registerWithInvite(db, { code, email: "friend@x.test", password: PW, now });
      assert.ok(r.ok && r.user.role === "user");
    } finally {
      db.close();
    }
  });

  it("--by must name an active admin", async () => {
    const t = env();
    await userCreateMain(["--email", "admin@x.test", "--password-stdin"], { env: t.env, readStdin: async () => PW, ...capture().io });
    await userCreateMain(["--email", "plain@x.test", "--role", "user", "--password-stdin"], { env: t.env, readStdin: async () => PW, ...capture().io });
    const c = capture();
    assert.equal(await userInviteMain(["--by", "plain@x.test"], { env: t.env, ...c.io }), 1);
    assert.equal(await userInviteMain(["--by", "nobody@x.test"], { env: t.env, ...capture().io }), 1);
    assert.equal(await userInviteMain(["--by", "ADMIN@x.test", "--role", "admin"], { env: t.env, ...capture().io }), 0);
  });
});
