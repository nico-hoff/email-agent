import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runEval } from "veryfront/eval";
import { buildGateEval } from "../lib/jev-gate-eval.ts";
import {
  GATE_DATASET_DIR,
  GATE_NOUL_THRESHOLD,
  gateDatasetFileName,
  gateLinesFromReport,
  gateVerdict,
  parseGateDataset,
  serializeGateDataset,
  toEvalExamples,
  type GateLine,
} from "../lib/eval-gate.ts";
import { QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { questionsFor } from "../lib/jev-questions.ts";
import { loadDataset, PROVISIONAL_NOUL_THRESHOLD, runEvalSet } from "../scripts/eval-jev.ts";
import type { JevClient } from "../lib/jev.ts";

const root = join(import.meta.dirname, "..");
const SET_V1 = loadDataset(join(root, "tests", "fixtures", "eval", "email-eval-v1.jsonl"));
const SET_V2 = loadDataset(join(root, "tests", "fixtures", "eval", "email-eval-v2.jsonl"));
const KNOWN_IDS = new Set([...SET_V1, ...SET_V2].map((c) => c.id));
const FIXTURE_IDS = ["fixture-v1-ad"];
const ALLOWED_IDS = new Set([...KNOWN_IDS, ...FIXTURE_IDS]);
const dir = join(root, GATE_DATASET_DIR);

function files(): string[] {
  return readdirSync(dir).filter((f) => /^email-eval-.*\.jsonl$/.test(f)).sort();
}

describe("committed gate datasets contain only synthetic ids and answers", () => {
  it("there is a baseline for question set v1", () => {
    assert.ok(existsSync(dir));
    assert.ok(files().includes(gateDatasetFileName("v1", "v1")), files().join(","));
  });

  for (const file of existsSync(dir) ? files() : []) {
    it(`${file}: ids from the synthetic sets, answers only keys/types/numbers/option names`, () => {
      const lines = parseGateDataset(readFileSync(join(dir, file), "utf8"), { allowedIds: ALLOWED_IDS });
      assert.ok(lines.length >= 29, "baseline is not empty");
      assert.equal(new Set(lines.map((l) => l.id)).size, lines.length);
      for (const l of lines) {
        const questions = questionsFor(l.question_set_version);
        assert.deepEqual(l.answers.map((a) => a.key).sort(), Object.keys(questions).sort(), l.id);
        for (const a of l.answers) {
          const q = questions[a.key];
          assert.equal(a.type, q?.type, `${l.id}.${a.key}`);
          if (a.type === "choice" && q?.type === "choice") assert.ok(Object.hasOwn(q.criteria, String(a.value)), `${l.id}.${a.key}`);
          if (a.type !== "choice") assert.equal(typeof a.value, "number");
        }
      }
    });

    it(`${file}: no subject or body text of the synthetic sets appears`, () => {
      const text = readFileSync(join(dir, file), "utf8");
      for (const c of [...SET_V1, ...SET_V2]) {
        if (c.subject.length > 6) assert.ok(!text.includes(c.subject), c.id);
        if (c.body.length > 6) assert.ok(!text.includes(c.body.slice(0, 30)), c.id);
      }
      assert.ok(!/@/.test(text), "no mail addresses");
    });
  }
});

describe("parseGateDataset", () => {
  const good: GateLine = {
    id: "v2-sec-1", dataset: "v2", question_set_version: QUESTION_SET_VERSION_V2, origin: "derived",
    expected: { category: "security_auth", is_phishing_or_scam: false },
    answers: [{ key: "is_phishing_or_scam", type: "noul", value: 0.1 }],
  };
  const text = (o: unknown) => `${JSON.stringify(o)}\n`;

  it("rejects an incomplete answer list (must cover the whole question set)", () => {
    assert.throws(() => parseGateDataset(text(good), { allowedIds: ALLOWED_IDS }), /gate_dataset_invalid/);
  });

  it("rejects ids outside the synthetic sets, extra fields and free text", () => {
    const full = fullLine("v2-sec-1");
    assert.deepEqual(parseGateDataset(serializeGateDataset([full]), { allowedIds: ALLOWED_IDS }), [full]);
    assert.throws(() => parseGateDataset(serializeGateDataset([{ ...full, id: "real-mail-17" }]), { allowedIds: ALLOWED_IDS }), /gate_dataset_invalid/);
    assert.throws(() => parseGateDataset(text({ ...full, body: "Hallo" }), { allowedIds: ALLOWED_IDS }), /gate_dataset_invalid/);
    assert.throws(() => parseGateDataset(text({ ...full, expected: { ...full.expected, subject: "x" } }), { allowedIds: ALLOWED_IDS }), /gate_dataset_invalid/);
    const free = { ...full, answers: full.answers.map((a) => (a.key === "category" ? { ...a, value: "Rechnung von Frau Muster" } : a)) };
    assert.throws(() => parseGateDataset(serializeGateDataset([free]), { allowedIds: ALLOWED_IDS }), /gate_dataset_invalid/);
    assert.throws(() => parseGateDataset("{not json}\n", { allowedIds: ALLOWED_IDS }), /gate_dataset_invalid/);
  });

  it("error messages carry no values", () => {
    try {
      parseGateDataset(text({ ...fullLine("v2-sec-1"), body: "GEHEIM-TEXT" }), { allowedIds: ALLOWED_IDS });
      assert.fail("must throw");
    } catch (e) {
      assert.ok(!String((e as Error).message).includes("GEHEIM-TEXT"));
    }
  });
});

function fullLine(id: string, overrides: Record<string, number | string> = {}): GateLine {
  const c = [...SET_V1, ...SET_V2].find((x) => x.id === id)!;
  const dataset = id.startsWith("v2-") ? "v2" : "v1";
  const version = dataset === "v2" ? QUESTION_SET_VERSION_V2 : QUESTION_SET_VERSION_V1;
  const answers = Object.entries(questionsFor(version)).map(([key, q]) => {
    const flag = (c.expected as Record<string, boolean | string | undefined>)[key];
    if (q.type === "noul") return { key, type: "noul" as const, value: (overrides[key] as number | undefined) ?? (flag === true ? 0.9 : 0.1) };
    if (q.type === "choice") return { key, type: "choice" as const, value: (overrides[key] as string | undefined) ?? (key === "category" && typeof flag === "string" ? flag : Object.keys(q.criteria)[0]) };
    return { key, type: "score" as const, value: 0 };
  });
  return { id, dataset, question_set_version: version, origin: "derived", expected: c.expected, answers };
}

describe("gate verdicts", () => {
  it("use the same provisional rule as eval:jev (raw >= 0.5 is true)", () => {
    assert.equal(GATE_NOUL_THRESHOLD, PROVISIONAL_NOUL_THRESHOLD);
    const l = fullLine("v2-sec-1", { is_phishing_or_scam: 0.5 });
    assert.deepEqual(gateVerdict(l), { category: "security_auth", is_assessable: true, is_spam: false, is_phishing_or_scam: true, addresses_an_ai: false, needs_my_reply: false });
    assert.equal(gateVerdict(fullLine("v2-sec-1", { is_phishing_or_scam: 0.49 })).is_phishing_or_scam, false);
  });

  it("covers only the expected questions", () => {
    const l = fullLine("v2-scam-1");
    assert.deepEqual(Object.keys(gateVerdict(l)).sort(), Object.keys(l.expected).sort());
  });

  it("a missing answer is a null verdict, never a pass", () => {
    const l = fullLine("v2-sec-1");
    const broken = { ...l, answers: l.answers.filter((a) => a.key !== "category") };
    assert.equal(gateVerdict(broken).category, null);
  });
});

describe("Veryfront dataset eval", () => {
  it("a dataset with a wrong answer fails the jsonMatch gate, the committed baseline passes", async () => {
    const { default: gate } = await import("../evals/jev-email.eval.ts");
    const report = await runEval(gate, { adapters: {} });
    assert.equal(report.summary.passRate, 1);
    assert.ok(report.summary.records >= 30, `records ${report.summary.records}`);

    const good = fullLine("v2-sec-1");
    const wrong = fullLine("v2-sec-1", { is_phishing_or_scam: 0.9 });
    const bad = await runEval(buildGateEval("eval:test-gate", toEvalExamples([wrong], "t")), { adapters: {} });
    assert.ok(bad.summary.passRate < 1);
    const ok = await runEval(buildGateEval("eval:test-gate", toEvalExamples([good], "t")), { adapters: {} });
    assert.equal(ok.summary.passRate, 1);
  });

  it("examples carry verdict as input and expected values as reference, namespaced by file", () => {
    const l = fullLine("v2-sec-1");
    const [ex] = toEvalExamples([l], "stem");
    assert.equal(ex.id, "stem:v2-sec-1");
    assert.deepEqual(ex.reference, l.expected);
    assert.deepEqual(ex.input, gateVerdict(l));
  });
});

describe("--write-dataset lines", () => {
  const cases = SET_V2.slice(0, 3);
  async function report(failAt?: number) {
    let n = 0;
    const jev: JevClient = {
      async classify({ state }) {
        if (n++ === failAt) return { ok: false, kind: "http", statusCode: 500, errorName: "E" };
        const c = cases.find((x) => x.subject === state.untrusted_subject)!;
        const e = c.expected as Record<string, boolean | string | undefined>;
        const answers: Record<string, unknown> = {};
        for (const [key, q] of Object.entries(questionsFor(QUESTION_SET_VERSION_V2))) {
          if (q.type === "noul") answers[key] = { type: "noul", noul: e[key] === true ? 0.9 : 0.1 };
          else if (q.type === "choice") answers[key] = { type: "choice", choice: Object.keys(q.criteria)[0] };
          else answers[key] = { type: "score", score: 0 };
        }
        return { ok: true, response: { answers, model: "m", usage: { inputTokens: 1, outputTokens: 1 } } as never };
      },
    };
    return runEvalSet({ jev, cases, questions: questionsFor(QUESTION_SET_VERSION_V2) });
  }

  it("builds lines from a clean live run without any mail text", async () => {
    const r = await report();
    const lines = gateLinesFromReport({ dataset: "v2", questionSetVersion: QUESTION_SET_VERSION_V2, cases, report: r, origin: "live" });
    assert.ok(lines);
    assert.equal(lines.length, 3);
    const text = serializeGateDataset(lines);
    for (const c of cases) assert.ok(!text.includes(c.subject) && !text.includes(c.body.slice(0, 30)));
    assert.equal(parseGateDataset(text, { allowedIds: ALLOWED_IDS }).length, 3);
  });

  it("refuses a partial run so the gate never shrinks silently", async () => {
    const r = await report(1);
    assert.equal(gateLinesFromReport({ dataset: "v2", questionSetVersion: QUESTION_SET_VERSION_V2, cases, report: r, origin: "live" }), null);
  });

  it("file names bind dataset and question set", () => {
    assert.equal(gateDatasetFileName("v1", "v1"), "email-eval-v1__qs-v1.jsonl");
    assert.equal(gateDatasetFileName("v2", "v2"), "email-eval-v2__qs-v2.jsonl");
  });
});

describe("CI", () => {
  it("runs the offline eval after the build", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    assert.match(ci, /- run: npm run eval\b/);
    assert.ok(ci.indexOf("npm run build") < ci.indexOf("npm run eval"));
    assert.ok(!/OPENROUTER|secrets\./.test(ci));
  });

  it("package.json keeps npm run eval offline (veryfront eval, no env file)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["eval"], "veryfront eval");
    assert.equal(pkg.scripts["jev:probe:v2"], "node --env-file=.env.local scripts/jev-v2-probe.ts");
  });
});
