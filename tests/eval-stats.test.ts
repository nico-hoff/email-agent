import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  balancedAccuracy,
  categoryMetrics,
  confusionAt,
  f1,
  precision,
  recall,
  rocAuc,
  specificity,
  wilson,
} from "../lib/eval-stats.ts";

const close = (a: number | null, b: number, eps = 1e-3) => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} vs ${b}`);
};

describe("wilson interval", () => {
  it("matches hand-computed values (z = 1.96)", () => {
    const w = wilson(8, 10)!;
    close(w.low, 0.4902);
    close(w.high, 0.9433);
    const z = wilson(0, 10)!;
    close(z.low, 0);
    close(z.high, 0.2775);
    const all = wilson(10, 10)!;
    close(all.low, 0.7225);
    close(all.high, 1);
  });
  it("is null without observations and rejects impossible counts", () => {
    assert.equal(wilson(0, 0), null);
    assert.equal(wilson(5, 3), null);
  });
});

describe("confusion matrix and derived scores", () => {
  // 3 positives (0.9, 0.8, 0.4) and 3 negatives (0.7, 0.3, 0.4), threshold 0.5.
  const pts = [
    { score: 0.9, expected: true },
    { score: 0.8, expected: true },
    { score: 0.4, expected: true },
    { score: 0.7, expected: false },
    { score: 0.3, expected: false },
    { score: 0.4, expected: false },
  ];
  it("counts TP/FP/FN/TN with score >= threshold as positive", () => {
    assert.deepEqual(confusionAt(pts, 0.5), { tp: 2, fp: 1, fn: 1, tn: 2 });
    assert.deepEqual(confusionAt(pts, 0.4), { tp: 3, fp: 2, fn: 0, tn: 1 });
  });
  it("computes precision, recall, F1, specificity, balanced accuracy", () => {
    const c = confusionAt(pts, 0.5);
    close(precision(c), 2 / 3);
    close(recall(c), 2 / 3);
    close(f1(c), 2 / 3);
    close(specificity(c), 2 / 3);
    close(balancedAccuracy(c), 2 / 3);
    const d = { tp: 3, fp: 1, fn: 0, tn: 3 };
    close(precision(d), 0.75);
    close(recall(d), 1);
    close(f1(d), (2 * 0.75) / 1.75);
    close(specificity(d), 3 / 4);
    close(balancedAccuracy(d), (1 + 3 / 4) / 2);
  });
  it("returns null for undefined ratios", () => {
    const none = { tp: 0, fp: 0, fn: 0, tn: 4 };
    assert.equal(precision(none), null);
    assert.equal(recall(none), null);
    assert.equal(f1(none), null);
    assert.equal(balancedAccuracy({ tp: 0, fp: 0, fn: 0, tn: 0 }), null);
  });
});

describe("rocAuc (rank method)", () => {
  it("handles ties with average ranks: 7.5 / 9", () => {
    close(
      rocAuc([
        { score: 0.9, expected: true }, { score: 0.8, expected: true }, { score: 0.4, expected: true },
        { score: 0.7, expected: false }, { score: 0.3, expected: false }, { score: 0.4, expected: false },
      ]),
      7.5 / 9,
      1e-9,
    );
  });
  it("is 1 for perfect, 0 for inverted, 0.5 for all-equal scores", () => {
    close(rocAuc([{ score: 1, expected: true }, { score: 0, expected: false }]), 1, 1e-12);
    close(rocAuc([{ score: 0, expected: true }, { score: 1, expected: false }]), 0, 1e-12);
    close(rocAuc([{ score: 0.5, expected: true }, { score: 0.5, expected: false }]), 0.5, 1e-12);
  });
  it("is null when one class is missing", () => {
    assert.equal(rocAuc([{ score: 1, expected: true }]), null);
    assert.equal(rocAuc([]), null);
  });
});

describe("categoryMetrics", () => {
  // expected/predicted: a->a, a->b, b->b, b->b, c->a
  const m = categoryMetrics([["a", "a"], ["a", "b"], ["b", "b"], ["b", "b"], ["c", "a"]]);
  it("computes accuracy and per-class precision/recall/F1", () => {
    close(m.accuracy, 3 / 5);
    assert.equal(m.n, 5);
    const a = m.perClass.find((c) => c.label === "a")!;
    close(a.precision, 1 / 2); close(a.recall, 1 / 2); close(a.f1, 1 / 2);
    assert.equal(a.support, 2);
    const b = m.perClass.find((c) => c.label === "b")!;
    close(b.precision, 2 / 3); close(b.recall, 1); close(b.f1, 0.8);
    const c = m.perClass.find((x) => x.label === "c")!;
    close(c.precision, 0); close(c.recall, 0); close(c.f1, 0);
  });
  it("macro-F1 is the unweighted mean over all labels", () => {
    close(m.macroF1, (0.5 + 0.8 + 0) / 3);
  });
  it("is empty-safe", () => {
    const e = categoryMetrics([]);
    assert.equal(e.n, 0);
    assert.equal(e.accuracy, null);
    assert.equal(e.macroF1, null);
  });
});
