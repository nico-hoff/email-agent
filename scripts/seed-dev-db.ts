// Fuellt die synthetische Dev-Datenbank (data/dev-synthetic.sqlite) aus den bereits geladenen Datensets
// (data/eval-datasets/, siehe `npm run eval:fetch`). Kein Jev-Aufruf, kein Netz, keine Kosten.
// Aufruf: node scripts/seed-dev-db.ts
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { importSyntheticCases, openSyntheticDevDatabase } from "../lib/synthetic-dev-db.ts";
import { loadHfCases } from "./eval-jev.ts";

export function seedDevDatabase(o: { root?: string; now?: Date } = {}): { cases: number } {
  const root = o.root ?? PROJECT_ROOT;
  const { cases } = loadHfCases(join(root, "data", "eval-datasets"), { includeUnlabeled: true });
  const db = openSyntheticDevDatabase(root);
  try {
    const r = importSyntheticCases(db, cases.map((c) => ({ case: c })), o.now ? { now: o.now } : {});
    return { cases: r.cases };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const r = seedDevDatabase();
    console.log(`dev:seed ${r.cases} synthetic mails in data/dev-synthetic.sqlite (no Jev calls, bodies are not stored)`);
  } catch (e) {
    const code = e instanceof Error ? (e.message === "datasets_missing" ? e.message : e.name) : "unknown";
    console.error(`dev:seed failed (${code})${code === "datasets_missing" ? "; run npm run eval:fetch first" : ""}`);
    process.exit(1);
  }
}
