// Reine Statistik-Hilfen fuer die Eval-Auswertung (compare-eval-runs, insights.md). Kein I/O.

export const Z_95 = 1.959964;

/** 95-%-Wilson-Score-Intervall fuer hits/n. null ohne Beobachtungen oder bei unmoeglichen Zaehlern. */
export function wilson(hits: number, n: number, z: number = Z_95): { low: number; high: number } | null {
  if (!(n > 0) || hits < 0 || hits > n) return null;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export type ScoredPoint = { score: number; expected: boolean };
export type Confusion = { tp: number; fp: number; fn: number; tn: number };

/** score >= threshold zaehlt als positiv. */
export function confusionAt(points: readonly ScoredPoint[], threshold: number): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const p of points) {
    const pred = p.score >= threshold;
    if (pred && p.expected) c.tp++;
    else if (pred) c.fp++;
    else if (p.expected) c.fn++;
    else c.tn++;
  }
  return c;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export const precision = (c: Confusion): number | null => ratio(c.tp, c.tp + c.fp);
export const recall = (c: Confusion): number | null => ratio(c.tp, c.tp + c.fn);
export const specificity = (c: Confusion): number | null => ratio(c.tn, c.tn + c.fp);

export function f1(c: Confusion): number | null {
  const p = precision(c);
  const r = recall(c);
  if (p === null || r === null) return null;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Mittel aus Recall und Specificity; nur mit beiden Klassen definiert. */
export function balancedAccuracy(c: Confusion): number | null {
  const r = recall(c);
  const s = specificity(c);
  return r === null || s === null ? null : (r + s) / 2;
}

/** ROC-AUC ueber das Rangverfahren (Mann-Whitney U) mit Durchschnittsraengen bei Gleichstaenden. */
export function rocAuc(points: readonly ScoredPoint[]): number | null {
  const pos = points.filter((p) => p.expected).length;
  const neg = points.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...points].sort((a, b) => a.score - b.score);
  let rankSumPos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) if (sorted[k].expected) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export type ClassMetrics = { label: string; support: number; precision: number; recall: number; f1: number };
export type CategoryMetrics = {
  n: number;
  accuracy: number | null;
  macroF1: number | null;
  perClass: ClassMetrics[];
};

/** Paare [erwartet, Antwort]. Macro-F1 ungewichtet ueber alle Labels, die erwartet oder geantwortet wurden;
 *  Precision/Recall ohne Nenner zaehlen als 0 (Konvention wie scikit-learn). */
export function categoryMetrics(pairs: ReadonlyArray<readonly [string, string]>): CategoryMetrics {
  const labels = [...new Set(pairs.flatMap(([e, a]) => [e, a]))].sort();
  const perClass: ClassMetrics[] = labels.map((label) => {
    const tp = pairs.filter(([e, a]) => e === label && a === label).length;
    const support = pairs.filter(([e]) => e === label).length;
    const predicted = pairs.filter(([, a]) => a === label).length;
    const p = predicted === 0 ? 0 : tp / predicted;
    const r = support === 0 ? 0 : tp / support;
    return { label, support, precision: p, recall: r, f1: p + r === 0 ? 0 : (2 * p * r) / (p + r) };
  });
  const correct = pairs.filter(([e, a]) => e === a).length;
  return {
    n: pairs.length,
    accuracy: pairs.length === 0 ? null : correct / pairs.length,
    macroF1: perClass.length === 0 ? null : perClass.reduce((s, c) => s + c.f1, 0) / perClass.length,
    perClass,
  };
}
