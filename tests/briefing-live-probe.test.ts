import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProbeArgs, PROBE_CONTEXT, runProbe } from "../scripts/briefing-live-probe.ts";
import { formatBriefingInput } from "../lib/briefing-context.ts";
import { fakeStreamAgent } from "./helpers/fake-stream-agent.ts";

const root = join(import.meta.dirname, "..");

test("args: --show is opt-in, unknown options are reported", () => {
  assert.deepEqual(parseProbeArgs([]), { confirmLive: false, show: false, unknown: [] });
  assert.deepEqual(parseProbeArgs(["--confirm-live", "--show"]), { confirmLive: true, show: true, unknown: [] });
  assert.deepEqual(parseProbeArgs(["--x"]).unknown, ["--x"]);
});

test("the script refuses to run without --confirm-live and without a key", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const none = spawnSync(process.execPath, [join(root, "scripts/briefing-live-probe.ts")], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--confirm-live/);
  const noKey = spawnSync(process.execPath, [join(root, "scripts/briefing-live-probe.ts"), "--confirm-live"], { env, encoding: "utf8" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
});

test("exactly one call with the built-in synthetic context; text only with --show; structure only otherwise", async () => {
  const hidden = fakeStreamAgent({ chunks: ["- SYNTH-A\n", "- SYNTH-B"] });
  const r = await runProbe(hidden.agent, false);
  assert.equal(hidden.calls.length, 1);
  assert.equal(hidden.calls[0].input, formatBriefingInput(PROBE_CONTEXT));
  assert.ok(r.ok);
  const text = r.lines.join("\n");
  assert.match(text, /model: openai\/openai\/gpt-6-luna/);
  assert.match(text, /latency_ms: \d+/);
  assert.match(text, /total_tokens: 120/);
  assert.match(text, /bullets: 2/);
  assert.match(text, /stream_chunks: 2/);
  assert.match(text, /contains_link: false/);
  assert.doesNotMatch(text, /SYNTH-A/);

  const shown = await runProbe(fakeStreamAgent({ chunks: ["- SYNTH-A"] }).agent, true);
  assert.match(shown.lines.join("\n"), /SYNTH-A/);

  const bad = await runProbe(fakeStreamAgent({ errorFrame: true, chunks: [] }).agent, true);
  assert.equal(bad.ok, false);
  assert.match(bad.lines.join("\n"), /code: agent_failed/);
});

test("the built-in context is synthetic and keeps the flagged mail out of the model input", () => {
  assert.doesNotMatch(formatBriefingInput(PROBE_CONTEXT), /wird nur gezählt/);
  assert.equal(PROBE_CONTEXT.flagged_count, 1);
});

test("package.json has the briefing:probe script without --confirm-live baked in", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["briefing:probe"], /scripts\/briefing-live-probe\.ts/);
  assert.doesNotMatch(pkg.scripts["briefing:probe"], /confirm-live/);
});
