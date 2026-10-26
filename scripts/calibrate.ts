// Kalibrierungsbericht (T24): Verteilung der noul-Rohwerte je Frage und Provider-Ordner,
// Precision/Recall gegen das Provider-Label. Liest nur SQLite, gibt nur Aggregate aus (H3/H4).
// Aufruf: npm run calibrate -- [--question-set <version>] [--account <id>] [--json]
import type { DatabaseSync } from "node:sqlite";

/** Thresholds 0.50 … 0.95 in steps of 0.05 (integer math, no float drift). */
export const THRESHOLDS: readonly number[] = Array.from({ length: 10 }, (_, i) => (50 + 5 * i) / 100);

export interface Distribution {
  n: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
}

export interface ThresholdRow {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** null when nothing is predicted positive. */
  precision: number | null;
  /** null when the provider labels nothing as spam. */
  recall: number | null;
}

export interface QuestionReport {
  key: string;
  distribution: { provider_inbox: Distribution | null; provider_spam: Distribution | null };
  thresholds: ThresholdRow[];
}

export interface GroupReport {
  question_set_version: string;
  model_requested: string;
  emails: { provider_inbox: number; provider_spam: number };
  excluded: { no_active_location: number; no_spam_mailbox: number };
  questions: QuestionReport[];
}

export interface CalibrationReport {
  groups: GroupReport[];
}

export interface CalibrateOptions {
  questionSet?: string | undefined;
  account?: string | undefined;
}

/** Linear interpolation between closest ranks (same as numpy's default). */
export function quantiles(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return { n: s.length, min: s[0], p10: at(0.1), median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

interface Point {
  value: number;
  providerSpam: boolean;
}

function thresholdRows(points: Point[]): ThresholdRow[] {
  return THRESHOLDS.map((threshold) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const p of points) {
      const predicted = p.value >= threshold;
      if (predicted && p.providerSpam) tp++;
      else if (predicted) fp++;
      else if (p.providerSpam) fn++;
      else tn++;
    }
    return {
      threshold, tp, fp, fn, tn,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
    };
  });
}

interface ClsRow {
  id: number;
  question_set_version: string;
  model_requested: string;
  spam_mailbox: string | null;
  folder: string | null;
}

/**
 * Provider label: the email's active location is the account's spam_mailbox.
 * Only classified rows count. Emails without an active location or whose account has no
 * spam_mailbox have no provider label and are only counted as excluded.
 */
export function buildCalibrationReport(db: DatabaseSync, opts: CalibrateOptions): CalibrationReport {
  const where = ["c.status = 'classified'"];
  const params: string[] = [];
  if (opts.questionSet !== undefined) {
    where.push("c.question_set_version = ?");
    params.push(opts.questionSet);
  }
  if (opts.account !== undefined) {
    where.push("e.account_id = ?");
    params.push(opts.account);
  }
  const rows = db.prepare(
    `SELECT c.id, c.question_set_version, c.model_requested, a.spam_mailbox, l.folder
     FROM classifications c
     JOIN emails e ON e.id = c.email_id
     JOIN accounts a ON a.id = e.account_id
     LEFT JOIN email_locations l ON l.id = (
       SELECT MAX(id) FROM email_locations WHERE email_id = e.id AND is_active = 1)
     WHERE ${where.join(" AND ")}
     ORDER BY c.question_set_version, c.model_requested, c.id`,
  ).all(...params) as unknown as ClsRow[];
  const answers = db.prepare(
    "SELECT question_key, answer_json FROM classification_answers WHERE classification_id = ? AND type = 'noul'",
  );

  const groups = new Map<string, { report: GroupReport; points: Map<string, Point[]> }>();
  for (const r of rows) {
    const gk = `${r.question_set_version}\u0000${r.model_requested}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        report: {
          question_set_version: r.question_set_version,
          model_requested: r.model_requested,
          emails: { provider_inbox: 0, provider_spam: 0 },
          excluded: { no_active_location: 0, no_spam_mailbox: 0 },
          questions: [],
        },
        points: new Map(),
      };
      groups.set(gk, g);
    }
    if (r.spam_mailbox === null) { g.report.excluded.no_spam_mailbox++; continue; }
    if (r.folder === null) { g.report.excluded.no_active_location++; continue; }
    const providerSpam = r.folder === r.spam_mailbox;
    if (providerSpam) g.report.emails.provider_spam++;
    else g.report.emails.provider_inbox++;
    for (const a of answers.all(r.id) as { question_key: string; answer_json: string }[]) {
      let value: unknown;
      try {
        value = (JSON.parse(a.answer_json) as { value?: unknown })?.value;
      } catch {
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const list = g.points.get(a.question_key) ?? [];
      list.push({ value, providerSpam });
      g.points.set(a.question_key, list);
    }
  }

  return {
    groups: [...groups.values()].map(({ report, points }) => ({
      ...report,
      questions: [...points.keys()].sort().map((key) => {
        const pts = points.get(key)!;
        return {
          key,
          distribution: {
            provider_inbox: quantiles(pts.filter((p) => !p.providerSpam).map((p) => p.value)),
            provider_spam: quantiles(pts.filter((p) => p.providerSpam).map((p) => p.value)),
          },
          thresholds: thresholdRows(pts),
        };
      }),
    })),
  };
}

const f2 = (n: number | null) => (n === null ? "  - " : n.toFixed(2));

function dist(label: string, d: Distribution | null): string {
  if (d === null) return `    ${label}: n=0`;
  return `    ${label}: n=${d.n} min=${f2(d.min)} p10=${f2(d.p10)} median=${f2(d.median)} p90=${f2(d.p90)} max=${f2(d.max)}`;
}

export function formatCalibrationReport(report: CalibrationReport): string {
  if (report.groups.length === 0) return "no classified emails";
  const out: string[] = [];
  for (const g of report.groups) {
    out.push(`${g.question_set_version} / ${g.model_requested}`);
    out.push(`  provider inbox=${g.emails.provider_inbox} spam=${g.emails.provider_spam}` +
      ` (excluded: no_active_location=${g.excluded.no_active_location} no_spam_mailbox=${g.excluded.no_spam_mailbox})`);
    for (const q of g.questions) {
      out.push(`  ${q.key}`);
      out.push(dist("inbox", q.distribution.provider_inbox));
      out.push(dist("spam ", q.distribution.provider_spam));
      out.push("    thr   prec  rec    tp   fp   fn   tn");
      for (const t of q.thresholds) {
        out.push(`    ${t.threshold.toFixed(2)}  ${f2(t.precision)}  ${f2(t.recall)}` +
          `  ${[t.tp, t.fp, t.fn, t.tn].map((n) => String(n).padStart(3)).join("  ")}`);
      }
    }
  }
  return out.join("\n");
}

export function parseCalibrateArgs(argv: string[]): { questionSet?: string; account?: string; json: boolean } {
  const out: { questionSet?: string; account?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--question-set" || a === "--account") {
      if (!v || v.startsWith("--")) throw new Error(`bad_args: ${a} needs a value`);
      if (a === "--question-set") out.questionSet = v;
      else out.account = v;
      i++;
    } else if (a === "--json") out.json = true;
    else throw new Error(`bad_args: unknown option ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseCalibrateArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : "bad_args");
    process.exit(2);
  }
  const { openDatabase } = await import("../lib/db.ts");
  const { validateDatabasePath } = await import("../lib/accounts.ts");
  const { PROJECT_ROOT } = await import("../lib/constants.ts");
  const db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
  try {
    const report = buildCalibrationReport(db, args);
    console.log(args.json ? JSON.stringify(report, null, 2) : formatCalibrationReport(report));
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();
