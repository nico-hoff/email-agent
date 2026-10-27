// Veryfront dataset eval for stored Jev verdicts (T27). Kept apart from lib/eval-gate.ts so that the CLI scripts do
// not load the eval runtime. No target and no model call: each example's `input` (the stored verdicts) is graded
// directly against its `reference` (the expected values) by the deterministic metric answer.jsonMatch as a gate.
import { datasets, evalDataset, metrics } from "veryfront/eval";
import type { GateExample } from "./eval-gate.ts";

export function buildGateEval(id: string, examples: readonly GateExample[]) {
  return evalDataset({
    id,
    description: "Stored Jev verdicts of the synthetic eval sets match the expected values (offline, no model call).",
    dataset: datasets.inline([...examples]),
    metrics: [metrics.answer.jsonMatch().gate()],
  });
}
