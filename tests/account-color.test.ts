import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_PALETTE, accountColor, accountTag } from "../lib/account-color.ts";

describe("accountColor", () => {
  test("keeps a configured color and otherwise picks a stable palette color by id", () => {
    assert.equal(accountColor("web", "#123abc"), "#123abc");
    const a = accountColor("web", null);
    assert.equal(accountColor("web", null), a);
    assert.equal(accountColor("web", undefined), a);
    assert.ok(ACCOUNT_PALETTE.includes(a));
    assert.ok(ACCOUNT_PALETTE.every((c) => /^#[0-9a-f]{6}$/.test(c)));
    assert.equal(new Set(ACCOUNT_PALETTE).size, ACCOUNT_PALETTE.length);
    const spread = new Set(["private", "domain", "work", "web1", "web2", "gmail"].map((id) => accountColor(id, null)));
    assert.ok(spread.size >= 3, "different ids do not all collapse onto one color");
  });
  test("accountTag exposes id, label and color only", () => {
    assert.deepEqual(accountTag({ id: "a1", label: "Work", color: null, host: "imap.secret.example" } as never), {
      id: "a1", label: "Work", color: accountColor("a1", null),
    });
  });
});
