import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createImapWritePort, ImapWriteError } from "../lib/imap-write.ts";

const root = join(import.meta.dirname, "..");
const CFG = { host: "imap.secret.example", port: 993, tls: true, user: "secret-user", password: "secret-pass" };

interface Opts {
  uidValidity?: bigint;
  storeResult?: boolean;
  flagsAfter?: Set<string> | false;
  connectError?: unknown;
  storeThrows?: boolean;
}
/** Fake ImapFlow client: records calls, every other method throws (expunge, delete, move, append, ...). */
class FakeClient {
  calls: string[] = [];
  locks: { folder: string; options: unknown }[] = [];
  released = 0;
  mailbox: { uidValidity: bigint } | false = false;
  o: Opts;
  constructor(o: Opts = {}) {
    this.o = o;
    return new Proxy(this, {
      get: (t, k, r) => {
        if (k in t || typeof k === "symbol") return Reflect.get(t, k, r);
        return () => { throw new Error(`forbidden call ${String(k)}`); };
      },
    });
  }
  on() {}
  async connect() {
    this.calls.push("connect");
    if (this.o.connectError) throw this.o.connectError;
  }
  async getMailboxLock(folder: string, options: unknown) {
    this.calls.push(`lock ${folder}`);
    this.locks.push({ folder, options });
    this.mailbox = { uidValidity: this.o.uidValidity ?? 7n };
    return { release: () => { this.released++; } };
  }
  async messageFlagsAdd(range: unknown, flags: string[], options: unknown) {
    this.calls.push(`add ${JSON.stringify(range)} ${flags.join(",")} ${JSON.stringify(options)}`);
    if (this.o.storeThrows) throw new Error("boom");
    return this.o.storeResult ?? true;
  }
  async messageFlagsRemove(range: unknown, flags: string[], options: unknown) {
    this.calls.push(`remove ${JSON.stringify(range)} ${flags.join(",")} ${JSON.stringify(options)}`);
    return this.o.storeResult ?? true;
  }
  async fetchOne(range: string, query: Record<string, unknown>, options: unknown) {
    this.calls.push(`fetchOne ${range} ${Object.keys(query).sort().join(",")} ${JSON.stringify(options)}`);
    if (this.o.flagsAfter === false) return false;
    return { uid: Number(range), flags: this.o.flagsAfter };
  }
  async logout() { this.calls.push("logout"); }
  close() { this.calls.push("close"); }
}
const portWith = (fake: FakeClient) => createImapWritePort(CFG, () => fake as never);
const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ImapWriteError ? e.code : `other:${String(e)}`; }
  return "none";
};

describe("ImapWritePort (H16, H16a)", () => {
  test("addSeen: own connection, writable lock, UIDVALIDITY checked, STORE by UID, verified, released", async () => {
    const fake = new FakeClient({ flagsAfter: new Set(["\\Seen"]) });
    await portWith(fake).addSeen("Junk", 7, 42);
    assert.deepEqual(fake.locks, [{ folder: "Junk", options: { readOnly: false } }]);
    assert.deepEqual(fake.calls, [
      "connect", "lock Junk", 'add [42] \\Seen {"uid":true}', 'fetchOne 42 flags,uid {"uid":true}', "logout",
    ]);
    assert.equal(fake.released, 1);
  });

  test("removeSeen mirrors addSeen with -FLAGS and checks the flag is gone", async () => {
    const fake = new FakeClient({ flagsAfter: new Set(["\\Answered"]) });
    await portWith(fake).removeSeen("INBOX", 7, 5);
    assert.ok(fake.calls.includes('remove [5] \\Seen {"uid":true}'));
    assert.ok(!fake.calls.some((c) => c.startsWith("add")));
    const stuck = new FakeClient({ flagsAfter: new Set(["\\Seen"]) });
    assert.equal(await codeOf(portWith(stuck).removeSeen("INBOX", 7, 5)), "store_unverified");
  });

  test("UIDVALIDITY mismatch: nothing is written, lock released, code uidvalidity_changed", async () => {
    const fake = new FakeClient({ uidValidity: 8n });
    assert.equal(await codeOf(portWith(fake).addSeen("INBOX", 7, 1)), "uidvalidity_changed");
    assert.ok(!fake.calls.some((c) => c.startsWith("add") || c.startsWith("remove")));
    assert.equal(fake.released, 1);
    assert.ok(fake.calls.includes("logout"));
  });

  test("messageFlagsAdd returning false is store_rejected (imapflow does not throw)", async () => {
    const fake = new FakeClient({ storeResult: false });
    assert.equal(await codeOf(portWith(fake).addSeen("INBOX", 7, 1)), "store_rejected");
    assert.equal(fake.released, 1);
    const fake2 = new FakeClient({ storeResult: false });
    assert.equal(await codeOf(portWith(fake2).removeSeen("INBOX", 7, 1)), "store_rejected");
  });

  test("a message that is gone or an unconfirmed flag fails instead of reporting success", async () => {
    assert.equal(await codeOf(portWith(new FakeClient({ flagsAfter: false })).addSeen("INBOX", 7, 1)), "message_gone");
    assert.equal(await codeOf(portWith(new FakeClient({ flagsAfter: new Set() })).addSeen("INBOX", 7, 1)), "store_unverified");
  });

  test("errors carry only a code: no host, user, password or server text", async () => {
    for (const [o, code] of [
      [{ connectError: Object.assign(new Error("Invalid credentials secret-user secret-pass"), { authenticationFailed: true }) }, "imap_auth"],
      [{ connectError: new Error("ECONNREFUSED imap.secret.example") }, "imap_error"],
      [{ storeThrows: true }, "imap_error"],
    ] as const) {
      const fake = new FakeClient(o);
      let err: unknown;
      try { await portWith(fake).addSeen("INBOX", 7, 1); } catch (e) { err = e; }
      assert.ok(err instanceof ImapWriteError);
      assert.equal(err.code, code);
      const text = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
      for (const secret of ["secret-user", "secret-pass", "imap.secret.example", "boom", "ECONNREFUSED"]) assert.ok(!text.includes(secret), secret);
      assert.ok(fake.calls.includes("logout") || fake.calls.includes("close"));
    }
  });

  test("invalid targets are rejected before any connection", async () => {
    const fake = new FakeClient();
    const p = portWith(fake);
    for (const [f, v, u] of [["", 7, 1], ["INBOX", 0, 1], ["INBOX", 7, 0], ["INBOX", 7, 1.5], ["INBOX", Number.NaN, 1]] as const) {
      assert.equal(await codeOf(p.addSeen(f, v, u)), "invalid_target");
    }
    assert.deepEqual(fake.calls, []);
  });

  test("the port has exactly two methods; the module never references destructive IMAP calls", () => {
    const port = createImapWritePort(CFG, () => new FakeClient() as never);
    assert.deepEqual(Object.keys(port).sort(), ["addSeen", "removeSeen"]);
    const src = readFileSync(join(root, "lib", "imap-write.ts"), "utf8");
    for (const bad of ["messageDelete", "expunge", "messageMove", "messageCopy", "append(", "moveTo", "messageFlagsSet", "\\\\Deleted"]) {
      assert.ok(!src.includes(bad), bad);
    }
    assert.ok(!/readOnly:\s*true/.test(src), "the write port always opens writable");
  });

  test("the read port keeps no write method (H2 stays)", () => {
    const src = readFileSync(join(root, "lib", "imap.ts"), "utf8");
    assert.ok(!/messageFlags(Add|Remove|Set)|messageDelete|messageMove|expunge|append\(/.test(src));
    assert.ok(!src.includes("readOnly: false"));
  });

  test("only lib/mailbox-actions.ts creates the write port", () => {
    const files: string[] = [];
    const skip = new Set(["node_modules", ".git", "tests", "data", "graphify-out", "dist", ".claude", ".veryfront", ".hermes"]);
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(root);
    const users = files.filter((f) => /createImapWritePort|imap-write\.ts/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();
    assert.deepEqual(users, ["lib/imap-write.ts", "lib/mailbox-actions.ts"]);
  });
});
