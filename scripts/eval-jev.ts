// Expliziter Runner fuer das synthetische Jev-Eval-Set (kein Chat-Agent, nicht in CI).
// `veryfront/eval` bietet nur Adapter fuer Agenten/AG-UI, keinen fuer normale SDK-Funktionen.
// Aufruf: node --env-file=.env.local scripts/eval-jev.ts --confirm-live
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJevClient, type JevClient } from "../lib/jev.ts";
import { buildState, QUESTIONS } from "../lib/jev-questions.ts";
import { normalizeAnswers, type NormalizedAnswer } from "../lib/jev-response.ts";
import { DEFAULT_DATABASE_PATH } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";

export const MAX_LIVE_CALLS = 30;

// VORLAEUFIG, nur fuer diese Eval-Statistik (nicht in lib/): ein noul-Rohwert >= 0.5 zaehlt als "true".
// Skala und Schwelle sind in docs/jev-contract.md nicht belegt; das Ergebnis dient zur Schwellenfindung.
export const PROVISIONAL_NOUL_THRESHOLD = 0.5;

export type EvalCase = {
  id: string;
  lang: string;
  sender_domain: string;
  subject: string;
  body: string;
  expected: {
    category: string;
    is_spam?: boolean;
    is_phishing_or_scam?: boolean;
    addresses_an_ai?: boolean;
    is_assessable?: boolean;
  };
};

export type QuestionStat = { n: number; hits: number; rate: number };

export type EvalReport = {
  total: number;
  errors: { count: number; byClass: Record<string, number> };
  perQuestion: Record<string, QuestionStat>;
  costTotal: number | null;
  noulThreshold: number;
};

const NOUL_QUESTIONS = ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "is_assessable"] as const;
const SCORED = ["category", ...NOUL_QUESTIONS] as const;

export function loadDataset(path: string): EvalCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as EvalCase);
}

export async function runEvalSet(input: { jev: JevClient; cases: EvalCase[] }): Promise<EvalReport> {
  const perQuestion: Record<string, QuestionStat> = {};
  for (const q of SCORED) perQuestion[q] = { n: 0, hits: 0, rate: 0 };
  const byClass: Record<string, number> = {};
  let errors = 0;
  let cost = 0;
  let costSeen = false;
  const bump = (k: string) => {
    errors++;
    byClass[k] = (byClass[k] ?? 0) + 1;
  };

  for (const c of input.cases) {
    const state = buildState({
      sender_domain: c.sender_domain,
      untrusted_subject: c.subject,
      untrusted_body: c.body,
    });
    const res = await input.jev.classify({ questions: QUESTIONS, state });
    if (!res.ok) {
      bump(`${res.kind}:${res.statusCode ?? "-"}:${res.errorName}`);
      continue;
    }
    const usage = res.response.usage as { cost?: unknown } | undefined;
    if (typeof usage?.cost === "number") {
      cost += usage.cost;
      costSeen = true;
    }
    const norm = normalizeAnswers(res.response.answers, QUESTIONS);
    if (!norm.ok) {
      bump(`invalid:${norm.code}`);
      continue;
    }
    const byKey = new Map<string, NormalizedAnswer>(norm.answers.map((a) => [a.key, a]));
    const hit = (q: string, ok: boolean) => {
      perQuestion[q].n++;
      if (ok) perQuestion[q].hits++;
    };
    hit("category", byKey.get("category")?.value === c.expected.category);
    for (const q of NOUL_QUESTIONS) {
      const exp = c.expected[q];
      if (exp === undefined) continue;
      const raw = byKey.get(q)?.value;
      hit(q, typeof raw === "number" && (raw >= PROVISIONAL_NOUL_THRESHOLD) === exp);
    }
  }
  for (const s of Object.values(perQuestion)) s.rate = s.n === 0 ? 0 : s.hits / s.n;
  return {
    total: input.cases.length,
    errors: { count: errors, byClass },
    perQuestion,
    costTotal: costSeen ? cost : null,
    noulThreshold: PROVISIONAL_NOUL_THRESHOLD,
  };
}

export function formatReport(r: EvalReport): string {
  const lines = [`eval:jev cases=${r.total} errors=${r.errors.count}`];
  for (const [k, n] of Object.entries(r.errors.byClass)) lines.push(`  error ${k}: ${n}`);
  for (const [q, s] of Object.entries(r.perQuestion)) {
    lines.push(`  ${q}: ${s.hits}/${s.n} (${(s.rate * 100).toFixed(0)}%)`);
  }
  lines.push(`  noul rule (provisional, eval-only): raw >= ${r.noulThreshold} counts as true`);
  lines.push(`  cost total: ${r.costTotal === null ? "n/a" : r.costTotal.toFixed(6)}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm-live")) {
    console.error("refusing to call the live endpoint without --confirm-live");
    process.exit(2);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set");
    process.exit(2);
  }
  const root = join(import.meta.dirname, "..");
  const cases = loadDataset(join(root, "tests", "fixtures", "eval", "email-eval-v1.jsonl"));
  if (cases.length > MAX_LIVE_CALLS) {
    console.error(`dataset has ${cases.length} cases, limit is ${MAX_LIVE_CALLS}`);
    process.exit(2);
  }
  const jev = createJevClient({ apiKey, timeoutMs: 60_000 });
  const report = await runEvalSet({ jev, cases });
  console.log(formatReport(report));

  const db = openDatabase(process.env.DATABASE_PATH ?? join(root, DEFAULT_DATABASE_PATH));
  try {
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, details_json)
       VALUES (?, ?, 'eval', 'eval_run', ?)`,
    ).run(
      new Date().toISOString(),
      crypto.randomUUID(),
      JSON.stringify({
        cases: report.total,
        errors: report.errors.count,
        hits: Object.fromEntries(Object.entries(report.perQuestion).map(([q, s]) => [q, [s.hits, s.n]])),
      }),
    );
  } finally {
    db.close();
  }
  process.exit(report.errors.count > 0 ? 1 : 0);
}

if (import.meta.main) await main();
