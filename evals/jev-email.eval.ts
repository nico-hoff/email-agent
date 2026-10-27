// `npm run eval` (offline, no secrets): grades the committed gate datasets in evals/datasets/ with Veryfront's
// evalDataset and metrics.answer.jsonMatch. Renewal after a live run: docs/eval-datasets.md, section Offline-Gate.
// The project root is the working directory (npm run eval); the Veryfront eval loader bundles this file, so
// import.meta.url is not usable here.
import { loadGateDatasets, toEvalExamples } from "../lib/eval-gate.ts";
import { buildGateEval } from "../lib/jev-gate-eval.ts";

const examples = loadGateDatasets(process.cwd()).flatMap((set) => toEvalExamples(set.lines, set.stem));
if (examples.length === 0) throw new Error("gate_dataset_empty: no cases in evals/datasets/");

export default buildGateEval("eval:jev-email", examples);
