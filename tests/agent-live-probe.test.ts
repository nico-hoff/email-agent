import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseProbeArgs, runProbe, PROBE_INPUT } from "../scripts/agent-live-probe.ts";
import type { DraftAgent } from "../lib/draft-reply.ts";

const root = join(import.meta.dirname, "..");
const GOOD = { draft: "SYNTH-DRAFT-TEXT", language: "de", tone: "formal", needs_human_check: true, reasons: ["a"] };

function agent(data: unknown) {
  let calls = 0;
  const a: DraftAgent = {
    generate: async () => { calls++; return { data, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }; },
  };
  return { a, calls: () => calls };
}

test("args: both flags are opt-in, unknown options are reported", () => {
  assert.deepEqual(parseProbeArgs([]), { confirmLive: false, showDraft: false, unknown: [] });
  assert.deepEqual(parseProbeArgs(["--confirm-live", "--show-draft"]), { confirmLive: true, showDraft: true, unknown: [] });
  assert.deepEqual(parseProbeArgs(["--x"]).unknown, ["--x"]);
});

test("the script refuses to run without --confirm-live and without a key", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const none = spawnSync(process.execPath, [join(root, "scripts/agent-live-probe.ts")], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--confirm-live/);
  const noKey = spawnSync(process.execPath, [join(root, "scripts/agent-live-probe.ts"), "--confirm-live"], { env, encoding: "utf8" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
});

test("exactly one call with the built-in synthetic mail; draft only with --show-draft", async () => {
  const hidden = agent(GOOD);
  const r = await runProbe(hidden.a, false);
  assert.equal(hidden.calls(), 1);
  assert.ok(r.ok);
  const text = r.lines.join("\n");
  assert.match(text, /model: openai\/openai\/gpt-6-luna/);
  assert.match(text, /latency_ms: \d+/);
  assert.match(text, /total_tokens: 15/);
  assert.match(text, /schema_valid: true/);
  assert.doesNotMatch(text, /SYNTH-DRAFT-TEXT/);

  const shown = await runProbe(agent(GOOD).a, true);
  assert.match(shown.lines.join("\n"), /SYNTH-DRAFT-TEXT/);

  const bad = await runProbe(agent({ draft: "x" }).a, true);
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.lines.join("\n"), /draft \(synthetic\)/);
  assert.equal(PROBE_INPUT.excerpt.trust, "untrusted");
});
