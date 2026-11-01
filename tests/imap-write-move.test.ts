// R9: the move of the write port against a fake ImapFlow client (ADR 0025 Teil 2, docs/imap-write-contract.md section 7).
// The fake throws on every method the port must never use (copy, delete, expunge, append, flags), so a call to any of them fails a test.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createImapWritePort, findTrashFolder, ImapWriteError, QUARANTINE_FOLDER } from "../lib/imap-write.ts";

const CFG = { host: "imap.secret.example", port: 993, tls: true, user: "secret-user", password: "secret-pass" };

interface Folder { path: string; name: string; specialUse?: string; specialUseSource?: string }
interface Opts {
  capabilities?: string[];
  prefix?: string;
  folders?: Folder[];
  messages?: Record<string, number[]>;
  uidValidity?: Record<string, number>;
  moveResult?: "ok" | "rejected" | "noop" | "no_copyuid" | "lost";
  connectError?: unknown;
  createThrows?: boolean;
}

class FakeClient {
  calls: string[] = [];
  mailbox: { path: string; uidValidity: bigint } | false = false;
  capabilities: Map<string, boolean | number>;
  namespace: { prefix: string; delimiter: string };
  folders: Folder[];
  messages: Map<string, Set<number>>;
  validity: Map<string, number>;
  created: string[] = [];
  nextUid = 9000;
  o: Opts;
  constructor(o: Opts = {}) {
    this.o = o;
    this.capabilities = new Map((o.capabilities ?? ["IMAP4rev1", "UIDPLUS", "MOVE"]).map((c) => [c, true]));
    this.namespace = { prefix: o.prefix ?? "", delimiter: o.prefix === "INBOX." ? "." : "/" };
    this.folders = o.folders ?? [{ path: "INBOX", name: "INBOX" }];
    this.messages = new Map(Object.entries(o.messages ?? { INBOX: [42] }).map(([k, v]) => [k, new Set(v)]));
    this.validity = new Map(Object.entries({ INBOX: 7, ...(o.uidValidity ?? {}) }));
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
  async list() {
    this.calls.push("list");
    return this.folders;
  }
  async mailboxCreate(path: string) {
    this.calls.push(`create ${path}`);
    if (this.o.createThrows) throw new Error("no");
    const full = this.namespace.prefix + path;
    this.created.push(full);
    this.folders.push({ path: full, name: path });
    this.messages.set(full, new Set());
    this.validity.set(full, 100);
    return { path: full, created: true };
  }
  async getMailboxLock(folder: string, options: { readOnly?: boolean }) {
    this.calls.push(`lock ${folder} ${options.readOnly === true ? "ro" : "rw"}`);
    this.mailbox = { path: folder, uidValidity: BigInt(this.validity.get(folder) ?? 1) };
    return { release: () => { this.calls.push(`release ${folder}`); } };
  }
  async fetchOne(range: string) {
    this.calls.push(`fetchOne ${range}`);
    const folder = this.mailbox ? this.mailbox.path : "";
    return this.messages.get(folder)?.has(Number(range)) ? { uid: Number(range) } : false;
  }
  async messageMove(range: number[], destination: string, options: { uid?: boolean }) {
    this.calls.push(`move ${JSON.stringify(range)} ${destination} ${JSON.stringify(options)}`);
    const src = this.mailbox ? this.mailbox.path : "";
    const mode = this.o.moveResult ?? "ok";
    if (mode === "rejected") return false;
    const uid = range[0];
    const newUid = this.nextUid++;
    if (mode !== "noop") this.messages.get(src)?.delete(uid);
    if (mode !== "lost" && mode !== "noop") (this.messages.get(destination) ?? this.messages.set(destination, new Set()).get(destination))?.add(newUid);
    if (mode === "no_copyuid") return { path: src, destination };
    return { path: src, destination, uidValidity: BigInt(this.validity.get(destination) ?? 1), uidMap: new Map([[uid, newUid]]) };
  }
  async logout() { this.calls.push("logout"); }
  close() { this.calls.push("close"); }
}

const portWith = (fake: FakeClient) => createImapWritePort(CFG, () => fake as never);
const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof ImapWriteError ? e.code : `other:${String(e)}`; }
  return "none";
};
const req = (over: Record<string, unknown> = {}) => ({ folder: "INBOX", uidValidity: 7, uid: 42, target: "quarantine" as const, inboxFolder: "INBOX", ...over });
const QFOLDERS: Folder[] = [{ path: "INBOX", name: "INBOX" }, { path: QUARANTINE_FOLDER, name: QUARANTINE_FOLDER }];
const hasNo = (fake: FakeClient, re: RegExp) => assert.ok(!fake.calls.some((c) => re.test(c)), `unexpected call ${fake.calls.join(" | ")}`);

describe("move: success and verification", () => {
  test("INBOX -> existing Quarantäne: own connection, writable source lock, UIDVALIDITY checked, native MOVE by UID, verified both sides", async () => {
    const fake = new FakeClient({ folders: QFOLDERS, uidValidity: { [QUARANTINE_FOLDER]: 100 }, messages: { INBOX: [42], [QUARANTINE_FOLDER]: [] } });
    const res = await portWith(fake).moveMessage(req());
    assert.deepEqual(res, { folder: QUARANTINE_FOLDER, uidValidity: 100, uid: 9000 });
    assert.deepEqual(fake.calls, [
      "connect", "list", "lock INBOX rw", "fetchOne 42", `move [42] ${QUARANTINE_FOLDER} {"uid":true}`, "fetchOne 42", "release INBOX",
      `lock ${QUARANTINE_FOLDER} ro`, "fetchOne 9000", `release ${QUARANTINE_FOLDER}`, "logout",
    ]);
    assert.deepEqual(fake.created, [], "an existing folder is not created");
  });

  test("Quarantäne is created on demand (write path), under the server's namespace prefix", async () => {
    const fake = new FakeClient({ prefix: "INBOX.", folders: [{ path: "INBOX", name: "INBOX" }] });
    const res = await portWith(fake).moveMessage(req());
    assert.deepEqual(fake.created, ["INBOX.Quarantäne"]);
    assert.equal(res.folder, "INBOX.Quarantäne");
    assert.ok(fake.calls.indexOf("create Quarantäne") < fake.calls.findIndex((c) => c.startsWith("move ")), "created before the move");
  });

  test("an existing prefixed Quarantäne folder is found, not created again", async () => {
    const fake = new FakeClient({ prefix: "INBOX.", folders: [{ path: "INBOX", name: "INBOX" }, { path: "INBOX.Quarantäne", name: "Quarantäne" }], uidValidity: { "INBOX.Quarantäne": 3 } });
    await portWith(fake).moveMessage(req());
    hasNo(fake, /^create/);
    assert.ok(fake.calls.some((c) => c.startsWith("move [42] INBOX.Quarantäne")));
  });

  test("folder creation failure is a code and nothing is moved", async () => {
    const fake = new FakeClient({ createThrows: true });
    assert.equal(await codeOf(portWith(fake).moveMessage(req())), "folder_create_failed");
    hasNo(fake, /^move|^lock/);
  });

  test("Quarantäne -> trash (special use \\Trash) and trash -> INBOX", async () => {
    const trash: Folder = { path: "Gelöscht", name: "Gelöscht", specialUse: "\\Trash", specialUseSource: "extension" };
    const f1 = new FakeClient({ folders: [...QFOLDERS, trash], messages: { [QUARANTINE_FOLDER]: [42], Gelöscht: [] }, uidValidity: { [QUARANTINE_FOLDER]: 7, Gelöscht: 2 } });
    const r1 = await portWith(f1).moveMessage(req({ folder: QUARANTINE_FOLDER, target: "trash" }));
    assert.equal(r1.folder, "Gelöscht");
    hasNo(f1, /^create/);
    const f2 = new FakeClient({ folders: [...QFOLDERS, trash], messages: { Gelöscht: [42], INBOX: [] }, uidValidity: { Gelöscht: 7 } });
    const r2 = await portWith(f2).moveMessage(req({ folder: "Gelöscht", target: "inbox", inboxFolder: "INBOX" }));
    assert.equal(r2.folder, "INBOX");
    hasNo(f2, /^list|^create/);
  });

  test("no COPYUID: the move is confirmed by the source alone and the new location stays unknown", async () => {
    const fake = new FakeClient({ folders: QFOLDERS, moveResult: "no_copyuid" });
    assert.deepEqual(await portWith(fake).moveMessage(req()), { folder: QUARANTINE_FOLDER });
    assert.ok(!fake.calls.some((c) => c.includes(`lock ${QUARANTINE_FOLDER}`)));
  });
});

describe("move: failures leave the mailbox untouched", () => {
  test("no MOVE capability: move_unsupported BEFORE anything else; no list, no create, no lock, no move, no fallback", async () => {
    const fake = new FakeClient({ capabilities: ["IMAP4rev1", "UIDPLUS"], folders: QFOLDERS });
    assert.equal(await codeOf(portWith(fake).moveMessage(req())), "move_unsupported");
    assert.deepEqual(fake.calls, ["connect", "logout"]);
  });

  test("UIDVALIDITY mismatch: uidvalidity_changed, no move", async () => {
    const fake = new FakeClient({ folders: QFOLDERS, uidValidity: { INBOX: 8 } });
    assert.equal(await codeOf(portWith(fake).moveMessage(req())), "uidvalidity_changed");
    hasNo(fake, /^move/);
    assert.ok(fake.calls.includes("release INBOX"));
  });

  test("the message is gone: message_gone, no move", async () => {
    const fake = new FakeClient({ folders: QFOLDERS, messages: { INBOX: [] } });
    assert.equal(await codeOf(portWith(fake).moveMessage(req())), "message_gone");
    hasNo(fake, /^move/);
  });

  test("the server rejects the MOVE: move_rejected", async () => {
    assert.equal(await codeOf(portWith(new FakeClient({ folders: QFOLDERS, moveResult: "rejected" })).moveMessage(req())), "move_rejected");
  });

  test("the message is still in the source afterwards: move_unverified", async () => {
    assert.equal(await codeOf(portWith(new FakeClient({ folders: QFOLDERS, moveResult: "noop" })).moveMessage(req())), "move_unverified");
  });

  test("the message is not in the target afterwards: move_unverified", async () => {
    assert.equal(await codeOf(portWith(new FakeClient({ folders: QFOLDERS, moveResult: "lost" })).moveMessage(req())), "move_unverified");
  });

  test("the target's UIDVALIDITY differs from COPYUID: move_unverified", async () => {
    const fake = new FakeClient({ folders: QFOLDERS, uidValidity: { [QUARANTINE_FOLDER]: 100 } });
    const orig = fake.getMailboxLock.bind(fake);
    fake.getMailboxLock = async (folder: string, o: { readOnly?: boolean }) => {
      if (folder === QUARANTINE_FOLDER && o.readOnly) fake.validity.set(folder, 101);
      return orig(folder, o);
    };
    assert.equal(await codeOf(portWith(fake).moveMessage(req())), "move_unverified");
  });

  test("auth error and connection error map to codes without server text", async () => {
    assert.equal(await codeOf(portWith(new FakeClient({ connectError: { authenticationFailed: true, response: "secret" } })).moveMessage(req())), "imap_auth");
    assert.equal(await codeOf(portWith(new FakeClient({ connectError: new Error("imap.secret.example refused") })).moveMessage(req())), "imap_error");
  });

  test("invalid targets never connect", async () => {
    for (const bad of [{ folder: "" }, { uidValidity: 0 }, { uid: -1 }, { uid: 1.5 }, { target: "inbox", inboxFolder: "" }]) {
      const fake = new FakeClient();
      assert.equal(await codeOf(portWith(fake).moveMessage(req(bad))), "invalid_target");
      assert.deepEqual(fake.calls, []);
    }
    const same = new FakeClient({ folders: QFOLDERS, messages: { [QUARANTINE_FOLDER]: [42] }, uidValidity: { [QUARANTINE_FOLDER]: 7 } });
    assert.equal(await codeOf(portWith(same).moveMessage(req({ folder: QUARANTINE_FOLDER }))), "invalid_target", "never move a mail onto itself");
    hasNo(same, /^move/);
  });
});

describe("trash detection (never created, never guessed)", () => {
  const f = (path: string, extra: Partial<Folder> = {}): Folder => ({ path, name: path.split(/[./]/).pop() ?? path, ...extra });
  test("special use \\Trash wins; a user/name-derived hint is the second choice; then the fallback names", () => {
    assert.equal(findTrashFolder([f("Papierkorb"), f("Weg", { specialUse: "\\Trash", specialUseSource: "extension" })]), "Weg");
    assert.equal(findTrashFolder([f("Papierkorb"), f("Bin", { specialUse: "\\Trash", specialUseSource: "name" })]), "Bin");
    for (const n of ["Trash", "Papierkorb", "Deleted Items", "Gelöschte Elemente", "INBOX.Trash"]) assert.equal(findTrashFolder([f("INBOX"), f(n)]), n, n);
    assert.equal(findTrashFolder([f("INBOX"), f("Archiv"), f("Quarantäne")]), undefined);
  });

  test("no trash folder: trash_not_found, nothing created, nothing moved", async () => {
    const fake = new FakeClient({ folders: QFOLDERS, messages: { [QUARANTINE_FOLDER]: [42] }, uidValidity: { [QUARANTINE_FOLDER]: 7 } });
    assert.equal(await codeOf(portWith(fake).moveMessage(req({ folder: QUARANTINE_FOLDER, target: "trash" }))), "trash_not_found");
    hasNo(fake, /^create|^move|^lock/);
  });

  test("only the quarantine target ever creates a folder", async () => {
    const f1 = new FakeClient({ folders: [{ path: "INBOX", name: "INBOX" }] });
    await codeOf(portWith(f1).moveMessage(req({ target: "trash" })));
    hasNo(f1, /^create/);
    const f2 = new FakeClient({ folders: [{ path: "INBOX", name: "INBOX" }], messages: { Archiv: [42], INBOX: [] }, uidValidity: { Archiv: 7 } });
    await codeOf(portWith(f2).moveMessage(req({ folder: "Archiv", target: "inbox" })));
    hasNo(f2, /^create/);
  });
});
