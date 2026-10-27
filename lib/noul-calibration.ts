// Versioned noul thresholds (O8/T25). The values live in config/noul-calibration.ts and are documented in
// docs/jev-contract.md (section Kalibrierung); a test keeps both in sync. Validated once at import: an invalid
// file stops the process with a clear code and never falls back to made-up values.
import { z } from "zod";
import calibrationFile from "../config/noul-calibration.ts";

export type NoulCalibrationErrorCode = "noul_calibration_invalid" | "noul_calibration_mismatch";

export class NoulCalibrationError extends Error {
  readonly code: NoulCalibrationErrorCode;
  constructor(code: NoulCalibrationErrorCode, detail?: string) {
    // Only field paths, never values.
    super(detail ? `${code}: ${detail}` : code);
    this.name = "NoulCalibrationError";
    this.code = code;
  }
}

const calibrationSchema = z.strictObject({
  version: z.string().min(1),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  question_set_version: z.string().min(1),
  rule: z.string().min(1),
  basis: z.array(z.string().min(1)).min(1),
  thresholds: z.record(z.string().min(1), z.number().min(0).max(1)).refine((t) => Object.keys(t).length > 0),
});

export type NoulCalibration = z.infer<typeof calibrationSchema>;

export function parseNoulCalibration(raw: unknown): NoulCalibration {
  const r = calibrationSchema.safeParse(raw);
  if (!r.success) {
    const paths = [...new Set(r.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
    throw new NoulCalibrationError("noul_calibration_invalid", paths);
  }
  return r.data;
}

/** Start-up cross-check against the question set: same version, thresholds only for noul questions. */
export function assertCalibrationMatchesQuestions(
  cal: NoulCalibration,
  questionSetVersion: string,
  noulKeys: readonly string[],
): void {
  if (cal.question_set_version !== questionSetVersion) {
    throw new NoulCalibrationError("noul_calibration_mismatch", "question_set_version");
  }
  for (const key of Object.keys(cal.thresholds)) {
    if (!noulKeys.includes(key)) throw new NoulCalibrationError("noul_calibration_mismatch", `thresholds.${key}`);
  }
}

export const NOUL_CALIBRATION: Readonly<NoulCalibration> = Object.freeze(parseNoulCalibration(calibrationFile));

/** Threshold for a question under a question set version, or null (unmapped). */
export function noulThreshold(
  key: string,
  questionSetVersion: string | undefined,
  cal: NoulCalibration = NOUL_CALIBRATION,
): number | null {
  if (questionSetVersion === undefined || questionSetVersion !== cal.question_set_version) return null;
  // Map instead of obj[key]: the Veryfront API loader rejects reads with a dynamic key.
  return new Map(Object.entries(cal.thresholds)).get(key) ?? null;
}
