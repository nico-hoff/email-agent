// Veryfront dataset eval for stored agent outputs (T43). Kept apart from lib/agent-eval-gate.ts so that the CLI scripts do
// not load the eval runtime. No target and no model call: each example's `input` (the deterministic check result of a
// stored output) is graded directly against its `reference` (clean) by metrics.answer.jsonMatch as a gate.
//
// Why jsonMatch and not a custom metric: veryfront/eval exports no public factory for custom metrics (createMetric is
// internal), and an EvalMetric needs gate()/soft()/budget() implemented by hand. The checks run before the dataset is built.
import { datasets, evalDataset, metrics } from "veryfront/eval";
import type { AgentGateExample } from "./agent-eval-gate.ts";

export function buildAgentGateEval(id: string, examples: readonly AgentGateExample[], description?: string) {
  return evalDataset({
    id,
    description: description ?? "Stored agent outputs of the synthetic eval sets meet all deterministic rules (offline, no model call).",
    dataset: datasets.inline([...examples]),
    metrics: [metrics.answer.jsonMatch().gate()],
  });
}
