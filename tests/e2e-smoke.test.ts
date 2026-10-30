import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSmoke, smokeItems } from "../scripts/e2e-smoke.ts";

describe("e2e smoke (T44)", () => {
  it("walks all flows against the synthetic service, offline, and prints one status line per step", async () => {
    const lines: string[] = [];
    const before = process.env.DATABASE_PATH;
    const r = await runSmoke({ log: (l) => lines.push(l) });
    assert.deepEqual(r.steps.filter((s) => !s.ok), [], lines.join("\n"));
    assert.equal(r.ok, true);
    assert.ok(r.steps.length >= 25);
    assert.ok(lines.every((l) => /^(ok|FAIL) \S.* \S+$/.test(l)), "one `ok|FAIL <step> <status>` line each");
    assert.ok(!lines.join("\n").includes("ZZSMOKE"), "no mail content in the output");
    assert.equal(process.env.DATABASE_PATH, before, "the environment is restored");
  });

  it("the built-in set covers spam, provider spam, open mails and a spam sender with at least three verdicts", () => {
    const items = smokeItems();
    const has = (i: (typeof items)[number], key: string, value: string) =>
      i.classification!.answers.some((a) => a.key === key && a.value === value);
    const spam = items.filter((i) => has(i, "category", "spam"));
    assert.ok(spam.length >= 3);
    assert.equal(new Set(spam.map((i) => i.case.sender_domain)).size, 1, "one sender collects the verdicts");
    assert.ok(items.some((i) => i.case.expected.is_spam === true && !spam.includes(i)), "provider spam that Jev does not call spam");
    assert.ok(items.filter((i) => has(i, "route", "draft_reply")).length >= 2);
  });
});
