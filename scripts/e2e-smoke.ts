// End-to-end smoke (Plan v5 T44): starts the real service in synthetic mode on a free port with a TEMP copy of the dev
// database, filled from a tiny built-in synthetic set (no Hugging Face download, no Jev call, no model call, no IMAP),
// and walks through the flows with real HTTP requests: auth, lists, detail, done/undone, feedback, sender HITL and
// rules, dry-run actions, undo, briefing (fallback), draft (409 in synthetic) and the CSRF negatives.
// Output: one line per step, `ok|FAIL <step> <status>`. Never prints mail data, headers, tokens or response bodies.
// Aufruf: npm run smoke:e2e   (Exitcode 1 bei Fehler)
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../server.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";
import type { NormalizedAnswer } from "../lib/jev-response.ts";
import { QUESTION_SET_VERSION } from "../lib/constants.ts";
import { createSseParser, type SseEvent } from "../lib/sse.ts";
import { recordJevSpam } from "../lib/senders.ts";
import { importSyntheticCases, openSyntheticDevDatabase, type SyntheticItem } from "../lib/synthetic-dev-db.ts";

/** Strings that only exist in the (never stored) synthetic mail bodies: they must not appear in any response. */
const BODY_MARKER = "ZZSMOKE-BODY-MARKER";
const SPAM_DOMAIN = "spam.example.test";
const SPAM_MAILS = 3;

export interface SmokeStep {
  name: string;
  ok: boolean;
  status: number | string;
}

export interface SmokeResult {
  ok: boolean;
  steps: SmokeStep[];
}

interface Profile {
  spam: number;
  category: string;
  route: string;
  urgency: number;
  importance: number;
  needsReply: number;
}

function answers(p: Profile): NormalizedAnswer[] {
  const score = new Map<string, number>([["urgency", p.urgency], ["importance", p.importance]]);
  const choice = new Map<string, string>([["category", p.category], ["route", p.route]]);
  const noul = new Map<string, number>([["is_spam", p.spam], ["needs_my_reply", p.needsReply]]);
  return Object.entries(QUESTIONS).map(([key, q]) =>
    q.type === "noul" ? { key, type: "noul" as const, value: noul.get(key) ?? 0.05 }
    : q.type === "choice" ? { key, type: "choice" as const, value: choice.get(key) ?? Object.keys(q.criteria)[0] }
    : { key, type: "score" as const, value: score.get(key) ?? 0 });
}

const SPAM_PROFILE: Profile = { spam: 0.99, category: "spam", route: "ignore", urgency: 0, importance: 0, needsReply: 0.02 };

function item(id: string, source: string, domain: string, subject: string, expectedSpam: boolean, p: Profile): SyntheticItem {
  return {
    case: { id, source, lang: "en", sender_domain: domain, subject, body: `${BODY_MARKER} ${id}`, expected: expectedSpam ? { is_spam: true } : {} },
    classification: { answers: answers(p), modelReported: "synthetic" },
  };
}

/** The built-in fallback set: spam in the provider folder, a provider-spam mail Jev does not call spam, open mails, noise. */
export function smokeItems(): SyntheticItem[] {
  const items: SyntheticItem[] = [];
  for (let i = 1; i <= SPAM_MAILS; i++) items.push(item(`triage-${i}`, "triage", SPAM_DOMAIN, `Smoke spam ${i}`, true, SPAM_PROFILE));
  items.push(item("triage-10", "triage", "provider.example.test", "Smoke provider spam", true,
    { spam: 0.05, category: "business", route: "digest", urgency: 1, importance: 1, needsReply: 0.1 }));
  items.push(item("sinabis-1", "sinabis", "a.example.test", "Smoke open urgent", false,
    { spam: 0.02, category: "business", route: "draft_reply", urgency: 3, importance: 2, needsReply: 0.9 }));
  items.push(item("sinabis-2", "sinabis", "b.example.test", "Smoke open later", false,
    { spam: 0.02, category: "personal", route: "draft_reply", urgency: 1, importance: 1, needsReply: 0.8 }));
  items.push(item("sinabis-3", "sinabis", "c.example.test", "Smoke notify", false,
    { spam: 0.02, category: "transactional", route: "notify", urgency: 2, importance: 3, needsReply: 0.1 }));
  items.push(item("sinabis-4", "sinabis", "d.example.test", "Smoke digest", false,
    { spam: 0.02, category: "business", route: "digest", urgency: 0, importance: 1, needsReply: 0.1 }));
  items.push(item("sinabis-5", "sinabis", "e.example.test", "Smoke newsletter", false,
    { spam: 0.1, category: "newsletter_promo", route: "ignore", urgency: 0, importance: 0, needsReply: 0.02 }));
  return items;
}

/** Temp root with a seeded copy of the dev database. Jev spam verdicts feed the sender counters like the pipeline does. */
function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "e2e-smoke-"));
  chmodSync(root, 0o700);
  const db = openSyntheticDevDatabase(root);
  try {
    importSyntheticCases(db, smokeItems(), { now: new Date() });
    const spam = db.prepare(
      `SELECT c.id AS cls, c.email_id AS email FROM classifications c
       JOIN classification_answers a ON a.classification_id = c.id AND a.question_key = 'category'
       WHERE c.question_set_version = ? AND json_extract(a.answer_json, '$.value') = 'spam' ORDER BY c.id`,
    ).all(QUESTION_SET_VERSION) as { cls: number; email: number }[];
    const ts = new Date().toISOString();
    for (const s of spam) recordJevSpam(db, s.email, s.cls, ts);
  } finally {
    db.close();
  }
  return root;
}

interface ListBody {
  emails: { id: number; urgency: number | null; open: boolean; done: boolean; category: string | null; route: string | null }[];
  counts: Record<string, number>;
}

export async function runSmoke(options: { log?: (line: string) => void } = {}): Promise<SmokeResult> {
  const out = options.log ?? ((l: string) => console.log(l));
  const steps: SmokeStep[] = [];
  const seenTexts: string[] = [];
  const record = (name: string, ok: boolean, status: number | string): boolean => {
    steps.push({ name, ok, status });
    out(`${ok ? "ok" : "FAIL"} ${name} ${status}`);
    return ok;
  };

  // Hard guarantee for "offline": no model key can reach any route, no external DB path leaks in.
  const saved = new Map<string, string | undefined>();
  for (const k of ["DATABASE_PATH", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ACCOUNTS_FILE"]) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  const root = seedRoot();
  let svc: Awaited<ReturnType<typeof createService>> | undefined;
  try {
    svc = await createService({ synthetic: true, projectRoot: root, port: 0, bindAddress: "127.0.0.1", onSignal: () => {}, log: () => {}, env: {} });
    const base = `http://127.0.0.1:${svc.port}`;

    // `fetch` wrapper: collects the response text for the marker test, never prints it.
    const req = async (path: string, init: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers }> => {
      const r = await fetch(`${base}${path}`, { redirect: "manual", ...init });
      const text = await r.text();
      seenTexts.push(text);
      return { status: r.status, text, headers: r.headers };
    };
    const json = <T>(text: string): T => JSON.parse(text) as T;

    /** Runs one step: `check` returns true when the response is as expected. Exceptions count as FAIL. */
    const step = async (name: string, run: () => Promise<{ status: number | string; ok: boolean }>): Promise<boolean> => {
      try {
        const r = await run();
        return record(name, r.ok, r.status);
      } catch {
        return record(name, false, "error");
      }
    };

    // --- without a session -------------------------------------------------------------------------------------
    await step("anon / redirects to /welcome", async () => {
      const r = await req("/");
      return { status: r.status, ok: r.status === 303 && (r.headers.get("location") ?? "").endsWith("/welcome") };
    });
    await step("anon GET /api/emails", async () => {
      const r = await req("/api/emails");
      return { status: r.status, ok: r.status === 401 };
    });
    await step("anon GET /api/health", async () => {
      const r = await req("/api/health");
      return { status: r.status, ok: r.status === 200 };
    });

    // --- login: Veryfront double-submit cookie plus the app token ----------------------------------------------
    let vf = "";
    let appCsrf = "";
    let session = "";
    const loggedIn = await step("login (dev identity)", async () => {
      const welcome = await req("/welcome", { headers: { accept: "text/html" } });
      vf = /__Host-vf_csrf=([^;]+)/.exec(welcome.headers.get("set-cookie") ?? "")?.[1] ?? "";
      appCsrf = json<{ csrfToken: string }>((await req("/api/auth/session")).text).csrfToken;
      const r = await req("/api/auth/login", {
        method: "POST",
        headers: { origin: base, "sec-fetch-site": "same-origin", "x-csrf-token": vf, cookie: `__Host-vf_csrf=${vf}`, "x-app-csrf": appCsrf },
      });
      session = (r.headers.get("set-cookie") ?? "").split(";")[0];
      return { status: r.status, ok: r.status === 200 && vf !== "" && session !== "" };
    });
    if (!loggedIn) return { ok: false, steps };

    const get = (path: string) => req(path, { headers: { cookie: session } });
    const mutationHeaders = (): Record<string, string> => ({
      origin: base, "sec-fetch-site": "same-origin", "x-csrf-token": vf, cookie: `__Host-vf_csrf=${vf}; ${session}`, "x-app-csrf": appCsrf,
    });
    const post = (path: string, body?: unknown, headers: Record<string, string> = mutationHeaders()) =>
      req(path, {
        method: "POST",
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // --- lists ---------------------------------------------------------------------------------------------------
    const total = smokeItems().length;
    const lists = new Map<string, ListBody>();
    for (const view of ["important", "open", "noise", "all"]) {
      await step(`GET /api/emails?view=${view}`, async () => {
        const r = await get(`/api/emails?view=${view}`);
        if (r.status !== 200) return { status: r.status, ok: false };
        const b = json<ListBody>(r.text);
        lists.set(view, b);
        const urg = b.emails.map((e) => e.urgency ?? -1);
        const sorted = urg.every((u, i) => i === 0 || urg[i - 1] >= u);
        const countsOk = b.counts.all === total && b.counts[view] === b.emails.length && b.counts.important + b.counts.noise === b.counts.all;
        const viewOk = view === "all" ? b.emails.length === total
          : view === "open" ? b.emails.length >= 1 && b.emails.every((e) => e.open)
          : b.emails.length >= 1;
        return { status: r.status, ok: sorted && countsOk && viewOk };
      });
    }
    const openList = lists.get("open")?.emails ?? [];
    const allList = lists.get("all")?.emails ?? [];
    const openId = openList[0]?.id ?? 0;
    const spamId = allList.find((e) => e.category === "spam")?.id ?? 0;
    await step("open view is sorted by urgency (urgent first)", async () => ({
      status: 200, ok: openList.length >= 2 && (openList[0].urgency ?? 0) > (openList[openList.length - 1].urgency ?? 0),
    }));
    await step("GET /api/emails/:id", async () => {
      const r = await get(`/api/emails/${openId}`);
      return { status: r.status, ok: r.status === 200 && json<{ id: number }>(r.text).id === openId };
    });
    await step("GET /api/emails/999999", async () => {
      const r = await get("/api/emails/999999");
      return { status: r.status, ok: r.status === 404 };
    });

    // --- done / undone ----------------------------------------------------------------------------------------
    await step("POST /done", async () => {
      const r = await post(`/api/emails/${openId}/done`);
      const after = (await get("/api/emails?view=open")).text;
      return { status: r.status, ok: r.status === 200 && json<ListBody>(after).emails.every((e) => e.id !== openId) };
    });
    await step("POST /undone", async () => {
      const r = await post(`/api/emails/${openId}/undone`);
      const after = (await get("/api/emails?view=open")).text;
      return { status: r.status, ok: r.status === 200 && json<ListBody>(after).emails.some((e) => e.id === openId) };
    });

    // --- feedback ---------------------------------------------------------------------------------------------
    await step("POST /feedback spam_correct", async () => {
      const r = await post(`/api/emails/${spamId}/feedback`, { kind: "spam_correct" });
      return { status: r.status, ok: r.status === 200 };
    });
    await step("POST /feedback category_wrong", async () => {
      const r = await post(`/api/emails/${openId}/feedback`, { kind: "category_wrong", value: "personal" });
      return { status: r.status, ok: r.status === 200 };
    });
    await step("POST /feedback invalid value", async () => {
      const r = await post(`/api/emails/${openId}/feedback`, { kind: "category_wrong", value: "nonsense" });
      return { status: r.status, ok: r.status === 400 };
    });

    // --- senders ----------------------------------------------------------------------------------------------
    await step("GET /api/senders/hitl (candidate)", async () => {
      const r = await get("/api/senders/hitl");
      const c = r.status === 200 ? json<{ candidates: { jev_spam_count: number }[] }>(r.text).candidates : [];
      return { status: r.status, ok: r.status === 200 && c.length >= 1 && c[0].jev_spam_count >= 3 };
    });
    let ruleId = 0;
    await step("POST /api/senders/rules blacklist", async () => {
      const r = await post("/api/senders/rules", { match: "domain", value: SPAM_DOMAIN, kind: "blacklist" });
      if (r.status === 200) ruleId = json<{ rule: { id: number } }>(r.text).rule.id;
      return { status: r.status, ok: r.status === 200 && ruleId > 0 };
    });
    await step("POST /api/senders/rules/:id/deactivate", async () => {
      const r = await post(`/api/senders/rules/${ruleId}/deactivate`);
      return { status: r.status, ok: r.status === 200 };
    });

    // --- dry-run actions and undo -----------------------------------------------------------------------------
    let plannedEmail = 0;
    await step("GET /api/actions?mode=dry_run (planned)", async () => {
      const r = await get("/api/actions?mode=dry_run");
      const a = r.status === 200 ? json<{ actions: { email_id: number; mode: string; status: string }[] }>(r.text).actions : [];
      plannedEmail = a[0]?.email_id ?? 0;
      return { status: r.status, ok: r.status === 200 && a.length >= 1 && a.every((x) => x.mode === "dry_run") };
    });
    await step("POST /unread (dry_run)", async () => {
      const r = await post(`/api/emails/${plannedEmail}/unread`);
      return { status: r.status, ok: r.status === 200 && json<{ mode: string }>(r.text).mode === "dry_run" };
    });

    // --- briefing (SSE, fallback) -----------------------------------------------------------------------------
    await step("POST /api/briefing (meta, delta, done, fallback)", async () => {
      const r = await post("/api/briefing");
      const parser = createSseParser();
      const events: SseEvent[] = [...parser.push(r.text.replace(/\r\n/g, "\n")), ...parser.flush()];
      const names = events.map((e) => e.event);
      const done = events.find((e) => e.event === "done")?.data as { source?: string } | undefined;
      const ok = r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/event-stream") &&
        names.includes("meta") && names.includes("delta") && done?.source === "fallback";
      return { status: r.status, ok };
    });

    // --- draft is not available in synthetic mode -------------------------------------------------------------
    await step("POST /draft not_available_in_synthetic", async () => {
      const r = await post(`/api/emails/${openId}/draft`);
      return { status: r.status, ok: r.status === 409 && json<{ error: string }>(r.text).error === "not_available_in_synthetic" };
    });

    // --- CSRF negatives ---------------------------------------------------------------------------------------
    await step("POST /done without x-app-csrf", async () => {
      const h = mutationHeaders();
      delete h["x-app-csrf"];
      const r = await post(`/api/emails/${openId}/done`, undefined, h);
      return { status: r.status, ok: r.status === 403 };
    });
    await step("POST /done foreign origin", async () => {
      const r = await post(`/api/emails/${openId}/done`, undefined, { ...mutationHeaders(), origin: "https://evil.example.test", "sec-fetch-site": "cross-site" });
      return { status: r.status, ok: r.status === 403 };
    });

    // --- no mail content anywhere -----------------------------------------------------------------------------
    await step("marker test: no body marker in any response", async () => ({
      status: seenTexts.length, ok: seenTexts.every((t) => !t.includes(BODY_MARKER)),
    }));
  } catch {
    record("smoke setup", false, "error");
  } finally {
    try {
      await svc?.stop();
    } catch {
      record("server stop", false, "error");
    }
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (steps.length > 0 && steps.every((s) => s.ok)) record("server stopped", true, "clean");
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}

if (import.meta.main) {
  const r = await runSmoke();
  console.log(r.ok ? "e2e smoke passed" : "e2e smoke FAILED");
  process.exit(r.ok ? 0 : 1);
}
