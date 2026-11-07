// `npm run eval` (offline, no secrets): grades the stored outputs of the briefing agent (evals/datasets/briefing__v1.jsonl)
// against the rules of the synthetic cases with the deterministic checks (packages/core/src/agent-eval-checks.ts) and Veryfront's
// evalDataset + metrics.answer.jsonMatch. Renewal after a live run: docs/agent-contract.md, section 7.
import { briefingGateExamples, loadBriefingCases, loadBriefingGate } from "../packages/core/src/agent-eval-gate.ts";
import { buildAgentGateEval } from "../packages/core/src/agent-gate-eval.ts";

const root = process.cwd();

export default buildAgentGateEval("eval:briefing-outputs", briefingGateExamples(loadBriefingCases(root), loadBriefingGate(root), "briefing__v1"));
