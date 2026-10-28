// POST /api/briefing (Plan v5 T56): builds the metadata context, streams the briefing agent's text as SSE.
// Order: session (401), rate limit (429), CSRF (403), then the context and the stream. Nothing but the audit row
// `briefing_generated` and user_state.last_opened_at is written; the text lives in the 5-minute memory cache only (D28).
// Module is reachable from API routes: no dynamic obj[key] reads (the Veryfront loader rejects them).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type AuthContext, guardMutation } from "./auth-runtime.ts";
import { fallbackBriefing, formatBriefingInput, loadBriefingContext, type BriefingContext } from "./briefing-context.ts";
import { BRIEFING_CACHE_MS, BRIEFING_MODEL, BRIEFING_TIMEOUT_MS } from "./constants.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { LAST_OPENED_KEY, setUserState } from "./user-state.ts";

/** The part of Veryfront's AgentStreamInput the briefing uses (esm/src/agent/types.d.ts). */
export interface BriefingStreamArgs {
  input: string;
  abortSignal?: AbortSignal;
  /** Text delta, as soon as the model produced it. */
  onChunk?: (text: string) => void;
  /** Completed response; `usage` carries the token counts. */
  onFinish?: (response: { text?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }) => void;
}

/** The part of AgentStreamResult in use: the body is an SSE stream the caller has to read to the end. */
export interface BriefingStreamResult {
  toDataStreamResponse(options?: { headers?: Record<string, string>; status?: number }): Response;
}

export interface BriefingAgent {
  stream(args: BriefingStreamArgs): Promise<BriefingStreamResult>;
}

export interface BriefingUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type BriefingStreamOutcome =
  | { ok: true; text: string; usage: BriefingUsage }
  | { ok: false; code: "agent_failed" | "empty_output" | "aborted"; text: string };

const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/**
 * Runs one agent.stream() call. Text deltas arrive through onChunk; the response body is read to its end because the
 * stream only advances while it is consumed, and to notice `{"type":"error"}` frames. No provider text is kept.
 */
export async function runBriefingStream(
  agent: BriefingAgent,
  input: string,
  o: { abortSignal?: AbortSignal; onDelta?: (text: string) => void },
): Promise<BriefingStreamOutcome> {
  let text = "";
  let usage: BriefingUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let errorFrame = false;
  try {
    const result = await agent.stream({
      input,
      ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}),
      onChunk: (chunk) => {
        if (typeof chunk !== "string" || chunk.length === 0) return;
        text += chunk;
        o.onDelta?.(chunk);
      },
      onFinish: (r) => {
        usage = { prompt_tokens: num(r?.usage?.promptTokens), completion_tokens: num(r?.usage?.completionTokens), total_tokens: num(r?.usage?.totalTokens) };
      },
    });
    const response = result.toDataStreamResponse();
    if (!response.ok) return { ok: false, code: "agent_failed", text };
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as unknown;
            if (typeof parsed === "object" && parsed !== null && new Map(Object.entries(parsed)).get("type") === "error") errorFrame = true;
          } catch {
            // not JSON (e.g. a [DONE] marker): ignore
          }
        }
      }
    }
  } catch {
    // No error details: provider messages could echo prompt content (H3/H4).
    return { ok: false, code: o.abortSignal?.aborted ? "aborted" : "agent_failed", text };
  }
  if (errorFrame) return { ok: false, code: "agent_failed", text };
  if (text.trim().length === 0) return { ok: false, code: "empty_output", text };
  return { ok: true, text, usage };
}

// ---- cache (D28) ----------------------------------------------------------------------------------------------

export interface CachedBriefing {
  text: string;
  open_total: number;
  listed: number;
}

export interface BriefingCache {
  get(key: string, nowMs: number): CachedBriefing | undefined;
  set(key: string, value: CachedBriefing, nowMs: number): void;
}

/** In-memory only, per identity; entries expire after `ttlMs`. Lost on restart on purpose. */
export function createBriefingCache(ttlMs: number = BRIEFING_CACHE_MS): BriefingCache {
  const entries = new Map<string, { value: CachedBriefing; expiresAt: number }>();
  return {
    get(key, nowMs) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= nowMs) {
        entries.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value, nowMs) {
      entries.set(key, { value, expiresAt: nowMs + ttlMs });
    },
  };
}

// ---- handler --------------------------------------------------------------------------------------------------

export interface BriefingDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  cache: BriefingCache;
  /** undefined = no model (fallback): synthetic mode, no key, agent not registered. Not called in synthetic mode. */
  agent(): BriefingAgent | undefined | Promise<BriefingAgent | undefined>;
  now?: () => Date;
  clock?: () => number;
  traceId?: () => string;
  timeoutMs?: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

type Send = (event: string, data: unknown) => void;

export async function handleBriefing(request: Request, deps: BriefingDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());

  const cached = deps.cache.get(gate.login, now().getTime());
  let ctx: BriefingContext | undefined;
  if (!cached) {
    let db: DatabaseSync | undefined;
    try {
      db = deps.openDb();
      ctx = loadBriefingContext(db, now());
    } catch {
      return json({ error: "briefing_unavailable" }, 500);
    } finally {
      db?.close();
    }
  }

  const client = new AbortController();
  request.signal?.addEventListener("abort", () => client.abort(), { once: true });
  const encoder = new TextEncoder();
  let closed = false;

  /** last_opened_at (the opening counts even for a cache hit or the fallback) and, for a model run, the audit row. */
  const finalize = (audit?: { model: string; latency_ms: number; usage: BriefingUsage; mails: number }): void => {
    if (client.signal.aborted) return;
    let db: DatabaseSync | undefined;
    try {
      db = deps.openDb();
      const ts = now().toISOString();
      setUserState(db, LAST_OPENED_KEY, { at: ts }, ts);
      if (audit) {
        db.prepare(
          `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
           VALUES (?, ?, 'system', 'briefing_generated', NULL, NULL, ?)`,
        ).run(ts, (deps.traceId ?? randomUUID)(), JSON.stringify({
          model: audit.model, latency_ms: audit.latency_ms, prompt_tokens: audit.usage.prompt_tokens,
          completion_tokens: audit.usage.completion_tokens, total_tokens: audit.usage.total_tokens, mails: audit.mails,
        }));
      }
    } catch {
      // The briefing was delivered; a failed bookkeeping write must not leak details either.
    } finally {
      db?.close();
    }
  };

  const produce = async (send: Send): Promise<void> => {
    if (cached) {
      send("meta", { source: "model", cached: true, open_total: cached.open_total, listed: cached.listed });
      send("delta", { text: cached.text });
      finalize();
      send("done", { source: "model", cached: true, model: BRIEFING_MODEL, mails: cached.listed });
      return;
    }
    const context = ctx!;
    const fallback = (): void => {
      send("delta", { text: fallbackBriefing(context) });
      finalize();
      send("done", { source: "fallback", cached: false, mails: context.mails.length });
    };

    let agent: BriefingAgent | undefined;
    if (!deps.auth.synthetic) {
      try {
        agent = await deps.agent();
      } catch {
        agent = undefined;
      }
    }
    if (!agent) {
      send("meta", { source: "fallback", cached: false, open_total: context.open_total, listed: context.mails.length });
      fallback();
      return;
    }

    send("meta", { source: "model", cached: false, open_total: context.open_total, listed: context.mails.length });
    const signal = AbortSignal.any([client.signal, AbortSignal.timeout(deps.timeoutMs ?? BRIEFING_TIMEOUT_MS)]);
    let streamed = 0;
    const started = clock();
    const outcome = await runBriefingStream(agent, formatBriefingInput(context), {
      abortSignal: signal,
      onDelta: (text) => {
        streamed += text.length;
        send("delta", { text });
      },
    });
    if (client.signal.aborted) return;
    if (!outcome.ok) {
      send("error", { code: "agent_failed", fallback: streamed === 0 });
      if (streamed === 0) fallback();
      return;
    }
    const latency_ms = Math.round(clock() - started);
    deps.cache.set(gate.login, { text: outcome.text, open_total: context.open_total, listed: context.mails.length }, now().getTime());
    finalize({ model: BRIEFING_MODEL, latency_ms, usage: outcome.usage, mails: context.mails.length });
    send("done", { source: "model", cached: false, model: BRIEFING_MODEL, latency_ms, mails: context.mails.length });
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        await produce(send);
      } catch {
        send("error", { code: "briefing_failed", fallback: false });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed by a cancel
          }
        }
      }
    },
    cancel() {
      closed = true;
      client.abort();
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
