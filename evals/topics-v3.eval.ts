// `npm run eval` (offline, no secrets, no model call): the topics gate (R8, ADR 0037). One example per committed gate
// dataset and model: the booleans of packages/core/src/topics-gate.ts (topic accuracy and macro-F1 on the full v3 question set,
// noul F1 not worse than v2) are graded against "all true" by Veryfront's metrics.answer.jsonMatch. Not green = `npm run eval` fails.
// The project root is the working directory (npm run eval); the Veryfront eval loader bundles this file, so
// import.meta.url is not usable here.
import { evaluateTopicsGate, loadTopicsGateDatasets, modelsOf, TOPICS_GATE } from "../packages/core/src/topics-gate.ts";
import { buildGateEval } from "../packages/core/src/jev-gate-eval.ts";

const examples = loadTopicsGateDatasets(process.cwd()).flatMap((set) =>
  modelsOf(set.lines).map((model) => {
    const r = evaluateTopicsGate(model, set.lines);
    return {
      id: `topics-v3:${set.file.replace(/\.jsonl$/, "")}`,
      input: {
        enough_topic_cases: r.topic.n >= TOPICS_GATE.minTopicCases,
        topic_gate: r.topic.ok,
        noul_gate: r.noul.ok,
      },
      reference: { enough_topic_cases: true, topic_gate: true, noul_gate: true },
      metadata: { dataset: set.file, question_set_version: "email-classification-v3", origin: "live" },
    };
  })
);
if (examples.length === 0) throw new Error("gate_dataset_empty: no topics-v3 datasets in evals/datasets/");

export default buildGateEval("eval:topics-v3", examples as unknown as Parameters<typeof buildGateEval>[1]);
