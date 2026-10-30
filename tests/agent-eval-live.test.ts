import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  BUDGETS,
  buildRunReport,
  estimateCostUsd,
  gateLinesFromRun,
  MAX_LIVE_CALLS,
  parseEvalArgs,
  plannedCalls,
  reportFileName,
  runLive,
  type JudgeFn,
} from "../scripts/agent-eval-live.ts";
import { formatBriefingInput } from "../lib/briefing-context.ts";
import { briefingContextOf, loadBriefingCases, loadReplyCases, parseBriefingGate, parseReplyGate, serializeBriefingGate, serializeReplyGate } from "../lib/agent-eval-gate.ts";
import { loadBriefingGate, loadReplyGate } from "../lib/agent-eval-gate.ts";
import type { DraftAgent } from "../lib/draft-reply.ts";
import { fakeStreamAgent } from "./helpers/fake-stream-agent.ts";

const root = join(import.meta.dirname, "..");
const REPLY = loadReplyCases(root);
const BRIEFING = loadBriefingCases(root);
const GOOD_REPLY = new Map(loadReplyGate(root).map((l) => [l.id, l.output]));
const GOOD_BRIEFING = new Map(loadBriefingGate(root).map((l) => [l.id, l.output.text]));

/** A fake reply agent that answers every case with the committed compliant output (matched by the subject in the input). */
function fakeReply(o: { mutate?: (id: string, out: Record<string, unknown>) => Record<string, unknown>; fail?: string; toolCalls?: boolean } = {}) {
  const seen: string[] = [];
  const agent: DraftAgent = {
    async generate({ input }) {
      const c = REPLY.find((x) => input.includes(`subject: ${x.subject}`))!;
      seen.push(c.id);
      if (o.fail === c.id) throw new Error("provider said: secret detail");
      const base = { ...GOOD_REPLY.get(c.id)! } as Record<string, unknown>;
      const data = o.mutate ? o.mutate(c.id, base) : base;
      return { data, usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 }, ...(o.toolCalls ? { toolCalls: [{ toolName: "get-email-context" }] } : {}) } as never;
    },
  };
  return { agent, seen };
}

/** A fake briefing agent: picks the compliant text by the open_total and the first subject of the input. */
function fakeBriefing(o: { text?: (id: string) => string } = {}) {
  const calls: string[] = [];
  const sse = fakeStreamAgent();
  const agent = {
    async stream(args: Parameters<typeof sse.agent.stream>[0]) {
      const c = BRIEFING.find((x) => formatBriefingInput(briefingContextOf(x)) === args.input)!;
      calls.push(c.id);
      const text = o.text ? o.text(c.id) : GOOD_BRIEFING.get(c.id)!;
      const fake = fakeStreamAgent({ chunks: [text], usage: { promptTokens: 300, completionTokens: 60, totalTokens: 360 } });
      return fake.agent.stream(args);
    },
  };
  return { agent, calls };
}

const clock = (step = 100) => {
  let t = 0;
  return () => (t += step);
};

describe("args and call plan", () => {
  it("parses flags; unknown flags and bad --set values are reported", () => {
    assert.deepEqual(parseEvalArgs([]), { confirmLive: false, set: "all", judge: false, writeDataset: false, unknown: [] });
    assert.deepEqual(parseEvalArgs(["--confirm-live", "--set", "drafts", "--judge", "--write-dataset"]), { confirmLive: true, set: "drafts", judge: true, writeDataset: true, unknown: [] });
    assert.deepEqual(parseEvalArgs(["--set", "x"]).unknown, ["--set x"]);
    assert.deepEqual(parseEvalArgs(["--set"]).unknown, ["--set"]);
    assert.deepEqual(parseEvalArgs(["--nope"]).unknown, ["--nope"]);
  });

  it("counts generation calls plus judge calls and stays within the hard limit of 25 only for sensible combinations", () => {
    assert.equal(MAX_LIVE_CALLS, 25);
    assert.equal(plannedCalls("drafts", false, 12, 8), 12);
    assert.equal(plannedCalls("briefing", false, 12, 8), 8);
    assert.equal(plannedCalls("all", false, 12, 8), 20);
    assert.equal(plannedCalls("drafts", true, 12, 8), 24);
    assert.equal(plannedCalls("briefing", true, 12, 8), 16);
    assert.equal(plannedCalls("all", true, 12, 8), 40);
  });

  it("estimates cost from tokens with the OpenRouter prices of the model (0.10 / 0.50 USD per million)", () => {
    assert.equal(estimateCostUsd({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }), 0.6);
    assert.equal(estimateCostUsd({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), 0);
  });

  it("report file names are agents-<iso>.json without colons", () => {
    assert.equal(reportFileName(new Date("2026-10-30T12:34:56.789Z")), "agents-2026-10-30T12-34-56-789Z.json");
  });
});

describe("runLive with fake agents (no network)", () => {
  it("runs all 20 cases once each, checks them and summarises cost and latency", async () => {
    const reply = fakeReply();
    const briefing = fakeBriefing();
    const run = await runLive({ set: "all", replyAgent: reply.agent, briefingAgent: briefing.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.equal(run.calls, 20);
    assert.deepEqual(reply.seen.sort(), REPLY.map((c) => c.id).sort());
    assert.deepEqual(briefing.calls.sort(), BRIEFING.map((c) => c.id).sort());
    assert.equal(run.cases.length, 20);
    assert.ok(run.cases.every((c) => c.ok && c.violations.length === 0 && !c.error), JSON.stringify(run.cases.filter((c) => !c.ok)));
    assert.equal(run.summary.drafts?.n, 12);
    assert.equal(run.summary.briefing?.n, 8);
    assert.equal(run.summary.drafts?.tokens.total_tokens, 12 * 500);
    assert.equal(run.summary.briefing?.tokens.total_tokens, 8 * 360);
    assert.ok((run.summary.drafts?.est_cost_usd ?? 0) > 0);
    assert.equal(run.summary.drafts?.latency_ms.max, 100);
    assert.equal(run.summary.drafts?.passed, 12);
    assert.equal(run.budget_violations.length, 0);
  });

  it("--set drafts only touches the reply agent; --set briefing only the briefing agent", async () => {
    const reply = fakeReply();
    const briefing = fakeBriefing();
    const d = await runLive({ set: "drafts", replyAgent: reply.agent, briefingAgent: briefing.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.equal(d.calls, 12);
    assert.equal(briefing.calls.length, 0);
    const b = await runLive({ set: "briefing", replyAgent: reply.agent, briefingAgent: briefing.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.equal(b.calls, 8);
    assert.equal(reply.seen.length, 12);
  });

  it("refuses a plan above the hard limit before the first call", async () => {
    const reply = fakeReply();
    const briefing = fakeBriefing();
    const judge: JudgeFn = async () => ({ score: 1 });
    await assert.rejects(
      runLive({ set: "all", replyAgent: reply.agent, briefingAgent: briefing.agent, replyCases: REPLY, briefingCases: BRIEFING, judge }),
      /call_limit_exceeded/,
    );
    assert.equal(reply.seen.length + briefing.calls.length, 0);
  });

  it("the call counter is a second line of defence: a custom lower limit stops the run", async () => {
    const reply = fakeReply();
    await assert.rejects(
      runLive({ set: "drafts", replyAgent: reply.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, maxCalls: 5 }),
      /call_limit_exceeded/,
    );
    assert.equal(reply.seen.length, 0);
  });

  it("rule violations turn the case red and are reported as codes only", async () => {
    const reply = fakeReply({
      mutate: (id, out) => (id === "rd-inj-link-de" ? { ...out, draft: `${out.draft as string} http://freigabe.phish-test.example/ok`, needs_human_check: false, reasons: [] } : out),
    });
    const run = await runLive({ set: "drafts", replyAgent: reply.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    const bad = run.cases.find((c) => c.id === "rd-inj-link-de")!;
    assert.equal(bad.ok, false);
    assert.ok(bad.violations.includes("link_in_draft"));
    assert.equal(run.summary.drafts?.passed, 11);
    assert.equal(run.summary.drafts?.failed, 1);
    const report = JSON.stringify(buildRunReport(run, { started_at: "t", model: "m", set: "drafts", judge: false }));
    assert.doesNotMatch(report, /phish-test|freigabe/);
    for (const c of REPLY) assert.ok(!report.includes(c.excerpt.slice(0, 25)), c.id);
  });

  it("an agent error is recorded as a code, never with the provider text, and does not stop the run", async () => {
    const reply = fakeReply({ fail: "rd-meeting-en" });
    const run = await runLive({ set: "drafts", replyAgent: reply.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    const failed = run.cases.find((c) => c.id === "rd-meeting-en")!;
    assert.equal(failed.error, "agent_failed");
    assert.equal(failed.ok, false);
    assert.equal(run.summary.drafts?.errors, 1);
    assert.doesNotMatch(JSON.stringify(run), /secret detail/);
    assert.equal(run.cases.length, 12);
  });

  it("a draft call that used a tool is a violation (the eval runs without tools)", async () => {
    const run = await runLive({ set: "drafts", replyAgent: fakeReply({ toolCalls: true }).agent, replyCases: REPLY.slice(0, 1), briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.ok(run.cases[0].violations.includes("tool_called"));
  });

  it("an invalid draft structure is an error case", async () => {
    const run = await runLive({ set: "drafts", replyAgent: fakeReply({ mutate: () => ({ draft: "x" }) }).agent, replyCases: REPLY.slice(0, 2), briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.ok(run.cases.every((c) => c.error === "invalid_output" && !c.ok));
  });

  it("briefing violations: four bullets, link, invented domain", async () => {
    const briefing = fakeBriefing({ text: (id) => (id === "bf-few-normal" ? "- a\n- b\n- c\n- d http://x.example/y von erfunden.example.test" : GOOD_BRIEFING.get(id)!) });
    const run = await runLive({ set: "briefing", briefingAgent: briefing.agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    const bad = run.cases.find((c) => c.id === "bf-few-normal")!;
    assert.equal(bad.ok, false);
    for (const v of ["too_many_bullets", "link_in_text"]) assert.ok(bad.violations.includes(v), v);
    assert.equal(run.summary.briefing?.failed, 1);
  });

  it("budgets: a slow or expensive call is listed; the run result stays complete", async () => {
    const run = await runLive({ set: "drafts", replyAgent: fakeReply().agent, replyCases: REPLY.slice(0, 2), briefingCases: BRIEFING, judge: null, clock: clock(BUDGETS.drafts.latency_ms + 1) });
    assert.equal(run.budget_violations.length, 2);
    assert.match(run.budget_violations[0], /^rd-.*: latency$/);
  });

  it("the judge is optional, counts as a call, and its failure is a code", async () => {
    const calls: string[] = [];
    const judge: JudgeFn = async ({ rubric, input, output }) => {
      calls.push(`${rubric.length > 10}:${input.length > 0}:${output.text.length > 0}`);
      if (calls.length === 2) throw new Error("provider said: secret detail");
      return { score: calls.length === 3 ? 0.4 : 0.9, pass: calls.length === 3 ? false : true };
    };
    const run = await runLive({ set: "briefing", briefingAgent: fakeBriefing().agent, replyCases: REPLY, briefingCases: BRIEFING, judge, clock: clock() });
    assert.equal(run.calls, 16);
    assert.equal(calls.length, 8);
    const byId = new Map(run.cases.map((c) => [c.id, c]));
    assert.deepEqual(byId.get(BRIEFING[1].id)?.judge, { error: "judge_failed" });
    assert.deepEqual(byId.get(BRIEFING[2].id)?.judge, { score: 0.4, pass: false });
    assert.equal(run.summary.briefing?.judge?.n, 7);
    assert.doesNotMatch(JSON.stringify(run), /secret detail/);
  });
});

describe("report and gate dataset", () => {
  it("the report carries ids, codes, tokens, latency and cost and no output text", async () => {
    const run = await runLive({ set: "all", replyAgent: fakeReply().agent, briefingAgent: fakeBriefing().agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    const report = buildRunReport(run, { started_at: "2026-10-30T12:00:00.000Z", model: "openai/openai/gpt-6-luna", set: "all", judge: false });
    const text = JSON.stringify(report);
    for (const t of [...GOOD_REPLY.values()].map((o) => o.draft as string)) assert.ok(!text.includes(t.slice(0, 30)));
    for (const t of GOOD_BRIEFING.values()) assert.ok(!text.includes(t.slice(0, 30)));
    assert.equal(report.kind, "agents");
    assert.equal(report.calls, 20);
    assert.ok(report.note.includes("synthetic"));
  });

  it("gateLinesFromRun builds live lines from a clean complete run that parse as gate datasets", async () => {
    const run = await runLive({ set: "all", replyAgent: fakeReply().agent, briefingAgent: fakeBriefing().agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    const lines = gateLinesFromRun(run, REPLY, BRIEFING);
    assert.ok(lines);
    assert.ok(lines.reply && lines.briefing);
    assert.ok(lines.reply.every((l) => l.origin === "live"));
    const ids = new Set(REPLY.map((c) => c.id));
    assert.equal(parseReplyGate(serializeReplyGate(lines.reply), ids).length, 12);
    assert.equal(parseBriefingGate(serializeBriefingGate(lines.briefing), new Set(BRIEFING.map((c) => c.id))).length, 8);
  });

  it("gateLinesFromRun writes a set only if it was complete and error free; rule violations are kept (the gate then shows them)", async () => {
    const withError = await runLive({ set: "drafts", replyAgent: fakeReply({ fail: "rd-meeting-en" }).agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.equal(gateLinesFromRun(withError, REPLY, BRIEFING)?.reply, undefined);
    const partial = await runLive({ set: "drafts", replyAgent: fakeReply().agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    const lines = gateLinesFromRun(partial, REPLY, BRIEFING);
    assert.equal(lines?.reply?.length, 12);
    assert.equal(lines?.briefing, undefined);
    const violating = await runLive({ set: "drafts", replyAgent: fakeReply({ mutate: (id, o) => (id === "rd-inj-iban-de" ? { ...o, draft: `${o.draft as string} DE12 3456 7890 1234 5678 90` } : o) }).agent, replyCases: REPLY, briefingCases: BRIEFING, judge: null, clock: clock() });
    assert.equal(gateLinesFromRun(violating, REPLY, BRIEFING)?.reply?.length, 12);
  });
});

describe("the script itself", () => {
  const script = join(root, "scripts/agent-eval-live.ts");
  const env = { PATH: process.env.PATH ?? "" };
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });

  it("refuses without --confirm-live, with unknown options, and with a plan above the limit", () => {
    const none = run([]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /--confirm-live/);
    const unknown = run(["--confirm-live", "--set", "x"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown option/);
    const tooMany = run(["--confirm-live", "--set", "all", "--judge"]);
    assert.equal(tooMany.status, 2);
    assert.match(tooMany.stderr, /call_limit_exceeded/);
  });

  it("refuses without an OpenRouter key, after all other checks", () => {
    const noKey = run(["--confirm-live", "--set", "drafts"]);
    assert.equal(noKey.status, 2);
    assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
  });
});
