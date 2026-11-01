// Allowlist of classifier models (ADR 0041). Fixed in code: free-text models do not exist. Pure data, no imports, so the
// browser bundle and the server read the same list. A model is only selectable when config/noul-calibration.ts has an
// entry for it under the default question set (lib/classifier-selection.ts checks that on the server).

/** Jev (System One): the default of every user. Same value as JEV_MODEL in lib/constants.ts (a test keeps them equal). */
export const JEV_CLASSIFIER = "typesafe/jev-1.13";
/** OpenRouter Decisions API; same value as LUNA_DECISIONS_MODEL in lib/decisions-client.ts (a test keeps them equal). */
export const LUNA_CLASSIFIER = "openai/gpt-6-luna-decisions";

export interface ClassifierModelInfo {
  id: string;
  label: string;
  description: string;
  /** USD per 1 000 mails with the full v2 question set, measured on synthetic data (docs/insights-models.md, table "Kosten und Latenz", suite hf-v2). */
  usdPer1000: number;
}

export const CLASSIFIER_MODELS: readonly ClassifierModelInfo[] = [
  { id: JEV_CLASSIFIER, label: "Jev", description: "Standard. Schnell und günstig.", usdPer1000: 0.059 },
  { id: LUNA_CLASSIFIER, label: "Luna Decisions", description: "Schärfere Wahrscheinlichkeiten, rund doppelt so langsam.", usdPer1000: 0.192 },
];

export const DEFAULT_CLASSIFIER = JEV_CLASSIFIER;

export function isClassifierModel(value: unknown): value is string {
  return typeof value === "string" && CLASSIFIER_MODELS.some((m) => m.id === value);
}

/** Price relative to the default model (Jev = 1), rounded to one decimal. */
export function relativeCost(model: ClassifierModelInfo): number {
  const base = CLASSIFIER_MODELS.find((m) => m.id === DEFAULT_CLASSIFIER)?.usdPer1000 ?? 1;
  return Math.round((model.usdPer1000 / base) * 10) / 10;
}
