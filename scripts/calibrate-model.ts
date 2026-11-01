// Calibration run for one classifier model on question set v2 (ADR 0041, ADR 0028: live calls, synthetic data only).
// node --env-file=<env file> scripts/calibrate-model.ts --confirm-live [--model <id>] [--seed 7] [--calib-n 150] [--test-n 200] [--max-calls 400]
// Draws the same stratified sample as the Jev runs of R7 (seed 7, balanced), asks the model the v2 questions for the calib
// and the test split plus the fixed set v2, and writes only numbers to data/eval-runs/model-calibration-*.json (gitignored):
// per case id, split, expected labels and the normalized noul/choice values. No subject, body, sender or raw response.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDecisionsClient } from "../lib/decisions-client.ts";
import { LUNA_CLASSIFIER } from "../lib/classifier-models.ts";
import { PROJECT_ROOT, QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { questionsFor } from "../lib/jev-questions.ts";
import { datasetPath, loadDataset, prepareHfSample, runEvalSet } from "./eval-jev.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm-live")) {
    console.error("live calls: pass --confirm-live (synthetic data only, ADR 0028)");
    process.exit(2);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY missing");
    process.exit(2);
  }
  const model = arg("--model", LUNA_CLASSIFIER);
  const seed = Number(arg("--seed", "7"));
  const calibN = Number(arg("--calib-n", "150"));
  const testN = Number(arg("--test-n", "200"));
  const maxCalls = Number(arg("--max-calls", "400"));
  const dir = join(PROJECT_ROOT, "data", "eval-datasets");
  const calib = prepareHfSample(dir, { seed, n: calibN, split: "calib", strategy: "balanced" });
  const test = prepareHfSample(dir, { seed, n: testN, split: "test", strategy: "balanced" });
  const fixed = loadDataset(datasetPath(PROJECT_ROOT, "v2"));
  const total = calib.cases.length + test.cases.length + fixed.length;
  if (total > maxCalls) throw new Error(`call budget exceeded: ${total} > ${maxCalls}`);
  const questions = questionsFor(QUESTION_SET_VERSION_V2);
  const client = createDecisionsClient({ apiKey, model });
  const out: Record<string, unknown> = { model, question_set_version: QUESTION_SET_VERSION_V2, seed, created: new Date().toISOString(), splits: {} };
  for (const [name, cases] of [["calib", calib.cases], ["test", test.cases], ["fixed-v2", fixed]] as const) {
    const report = await runEvalSet({ jev: client, cases, questions });
    (out.splits as Record<string, unknown>)[name] = {
      n: cases.length, errors: report.errors, cost_total: report.costTotal,
      cases: report.caseResults.map((r) => ({
        id: r.id, source: r.source ?? null, expected: r.expected, error: r.error ?? null,
        answers: (r.answers ?? []).filter((a) => a.type !== "score").map((a) => ({ key: a.key, type: a.type, value: a.value })),
      })),
    };
    console.log(`${name}: n=${cases.length} errors=${report.errors.count} cost=${report.costTotal ?? "n/a"}`);
  }
  const runs = join(PROJECT_ROOT, "data", "eval-runs");
  mkdirSync(runs, { recursive: true });
  const file = join(runs, `model-calibration-${model.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out));
  console.log(`written: ${file}`);
}

await main();
