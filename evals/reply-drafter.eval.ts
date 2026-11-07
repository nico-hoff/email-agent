// `npm run eval` (offline, no secrets): grades the stored outputs of the reply agent (evals/datasets/reply-drafter__v1.jsonl)
// against the rules of the synthetic cases with the deterministic checks (packages/core/src/agent-eval-checks.ts) and Veryfront's
// evalDataset + metrics.answer.jsonMatch. Renewal after a live run: docs/agent-contract.md, section 7.
// The project root is the working directory (npm run eval); the Veryfront eval loader bundles this file, so
// import.meta.url is not usable here.
import { loadReplyCases, loadReplyGate, replyGateExamples } from "../packages/core/src/agent-eval-gate.ts";
import { buildAgentGateEval } from "../packages/core/src/agent-gate-eval.ts";

const root = process.cwd();

export default buildAgentGateEval("eval:reply-drafter-outputs", replyGateExamples(loadReplyCases(root), loadReplyGate(root), "reply-drafter__v1"));
