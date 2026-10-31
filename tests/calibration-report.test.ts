import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pointsFor, selectThreshold, sweep, SWEEP } from "../scripts/calibration-report.ts";

const mk = (id: string, expected: Record<string, unknown>, key: string, value: number | string, type = "noul") => ({
  id, expected, answers: [{ key, type, value }],
});

describe("calibration report", () => {
  it("pointsFor takes only noul numbers with a boolean expectation", () => {
    const cases = [
      mk("a", { is_spam: true }, "is_spam", 0.9),
      mk("b", { is_spam: false }, "is_spam", 0.1),
      mk("c", {}, "is_spam", 0.5),
      mk("d", { is_spam: true }, "is_spam", "x", "choice"),
      { id: "e", expected: { is_spam: true } },
    ];
    assert.deepEqual(pointsFor(cases, "is_spam"), [{ score: 0.9, expected: true }, { score: 0.1, expected: false }]);
  });

  it("pointsFor can be restricted by action; unknown actions drop out", () => {
    const cases = [mk("t-1", { needs_my_reply: true }, "needs_my_reply", 0.8), mk("t-2", { needs_my_reply: false }, "needs_my_reply", 0.7), mk("t-3", { needs_my_reply: false }, "needs_my_reply", 0.2)];
    const lookup = (id: string) => new Map([["t-1", "reply"], ["t-2", "forward"]]).get(id);
    assert.equal(pointsFor(cases, "needs_my_reply", { actions: ["reply", "ignore"], lookup }).length, 1);
  });

  it("sweep: the boundary counts as positive", () => {
    const rows = sweep([{ score: 0.7, expected: true }, { score: 0.69, expected: false }], [0.7]);
    assert.deepEqual(rows[0].c, { tp: 1, fp: 0, fn: 0, tn: 1 });
    assert.equal(SWEEP[0], 0.05);
    assert.equal(SWEEP.at(-1), 0.95);
  });

  it("selectThreshold: best F1 among rows with enough precision, else the most precise row", () => {
    const pts = [
      { score: 0.95, expected: true }, { score: 0.8, expected: true }, { score: 0.6, expected: true },
      { score: 0.55, expected: false }, { score: 0.2, expected: false },
    ];
    const rows = sweep(pts, [0.5, 0.6, 0.7, 0.9]);
    assert.equal(selectThreshold(rows, 1), 0.6);
    assert.equal(selectThreshold(sweep([{ score: 0.9, expected: false }, { score: 0.8, expected: true }], [0.5, 0.85, 0.95]), 1), 0.5);
    assert.equal(selectThreshold([], 1), null);
  });
});
