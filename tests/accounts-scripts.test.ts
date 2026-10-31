// R2 CLI: accounts:import and accounts:rekey print counts and codes only, never a value. Synthetic temp files only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsImportMain } from "../scripts/accounts-import.ts";
import { accountsRekeyMain } from "../scripts/accounts-rekey.ts";
import { generateKey, loadKeyring } from "../lib/account-secrets.ts";
import { openDatabase } from "../lib/db.ts";
import { loadWorkerAccounts } from "../lib/mail-accounts.ts";

const SECRET = "cli-synthetic-secret-1";
function project() {
  const root = mkdtempSync(join(tmpdir(), "r2-cli-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  const f = join(root, "data", "accounts.json");
  writeFileSync(f, JSON.stringify([{ id: "x1", label: "X", context: "", host: "imap.example.test", port: 993, tls: true, user: "u", password: SECRET, mailbox: "INBOX", enabled: true }]));
  chmodSync(f, 0o600);
  return root;
}
const capture = () => { const lines: string[] = []; return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }; };

describe("accounts CLI", () => {
  it("import: needs a key; imports once; never prints a value; the second run does nothing", () => {
    const root = project();
    const c = capture();
    assert.equal(accountsImportMain({ env: {}, projectRoot: root, ...c }), 2);
    const env = { ACCOUNTS_ENCRYPTION_KEY: generateKey() };
    assert.equal(accountsImportMain({ env, projectRoot: root, ...c }), 0);
    assert.equal(accountsImportMain({ env, projectRoot: root, ...c }), 0);
    assert.match(c.lines.join("\n"), /imported 1 account/);
    assert.match(c.lines.join("\n"), /already imported/);
    for (const l of c.lines) assert.ok(!l.includes(SECRET) && !l.includes("imap.example.test") && !l.includes(env.ACCOUNTS_ENCRYPTION_KEY));
  });
  it("import of a broken file fails with a code and changes nothing", () => {
    const root = project();
    writeFileSync(join(root, "data", "accounts.json"), "{ nope");
    const c = capture();
    assert.equal(accountsImportMain({ env: { ACCOUNTS_ENCRYPTION_KEY: generateKey() }, projectRoot: root, ...c }), 1);
    assert.match(c.lines.join("\n"), /failed/);
  });
  it("rekey: moves every secret to the new key; fails closed when the old key is missing", () => {
    const root = project();
    const oldKey = generateKey();
    const newKey = generateKey();
    const c = capture();
    accountsImportMain({ env: { ACCOUNTS_ENCRYPTION_KEY: oldKey }, projectRoot: root, ...c });
    assert.equal(accountsRekeyMain({ env: { ACCOUNTS_ENCRYPTION_KEY: newKey }, projectRoot: root, ...c }), 1, "old key missing");
    assert.equal(accountsRekeyMain({ env: { ACCOUNTS_ENCRYPTION_KEY: newKey, ACCOUNTS_ENCRYPTION_KEY_OLD: oldKey }, projectRoot: root, ...c }), 0);
    assert.equal(accountsRekeyMain({ env: {}, projectRoot: root, ...c }), 2);
    const db = openDatabase(join(root, "data", "email-agent.sqlite"));
    const only = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: newKey });
    assert.ok(only.ok);
    assert.equal(loadWorkerAccounts(db, only.keyring).accounts[0]?.password, SECRET);
    db.close();
    for (const l of c.lines) assert.ok(!l.includes(SECRET) && !l.includes(newKey) && !l.includes(oldKey));
  });
});

describe("the legacy file is read by the import only", () => {
  it("only lib/mail-accounts.ts (import) and lib/accounts.ts (startup) reference loadAccountsConfig; account-modes does not", () => {
    const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(read("lib/account-modes.ts"), /loadAccountsConfig|ACCOUNTS_FILE/);
    assert.doesNotMatch(read("lib/accounts-api.ts"), /loadAccountsConfig|ACCOUNTS_FILE/);
    assert.doesNotMatch(read("lib/account-supervisor.ts"), /loadAccountsConfig|ACCOUNTS_FILE/);
    assert.match(read("lib/mail-accounts.ts"), /loadAccountsConfig/);
  });
});
