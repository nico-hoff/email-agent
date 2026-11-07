// Browser side of POST /api/briefing (T56, docs/agent-contract.md section 6). The text is plain text with "- " bullets:
// it is split into lines here and rendered as text nodes, never as HTML or Markdown. The text is not stored anywhere.
import { commonReason, postApi } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";
import { readSseEvents, type SseEvent } from "./sse.ts";

export const FALLBACK_LABEL = "Zusammenfassung ohne KI";

export type BriefingPhase = "idle" | "loading" | "streaming" | "done" | "error";
export type BriefingErrorCode = "rate_limited" | "forbidden" | "failed" | "agent_failed" | "briefing_failed" | "stream_ended";

export interface BriefingState {
  phase: BriefingPhase;
  text: string;
  source: "model" | "fallback" | null;
  cached: boolean;
  openTotal: number | null;
  error: { code: BriefingErrorCode; fallback: boolean } | null;
}

export const INITIAL_BRIEFING: BriefingState = { phase: "idle", text: "", source: null, cached: false, openTotal: null, error: null };

export const BRIEFING_ERROR_TEXT: Record<BriefingErrorCode, string> = {
  rate_limited: "Zu viele Abrufe. Bitte gleich noch einmal versuchen.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  failed: "Die Zusammenfassung ist gerade nicht erreichbar.",
  agent_failed: "Die Zusammenfassung konnte nicht erstellt werden.",
  briefing_failed: "Die Zusammenfassung konnte nicht erstellt werden.",
  stream_ended: "Die Verbindung ist abgebrochen.",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asSource = (v: unknown): "model" | "fallback" | null => (v === "model" || v === "fallback" ? v : null);

/** Pure state machine over the SSE events of the contract. Unknown or malformed events change nothing. */
export function reduceBriefing(s: BriefingState, e: SseEvent): BriefingState {
  const d = e.data;
  if (!isRecord(d)) return s;
  switch (e.event) {
    case "meta":
      return {
        ...s,
        phase: "streaming",
        source: asSource(d.source) ?? s.source,
        cached: d.cached === true,
        openTotal: typeof d.open_total === "number" ? d.open_total : s.openTotal,
        error: null,
      };
    case "delta":
      return typeof d.text === "string" ? { ...s, phase: s.phase === "loading" ? "streaming" : s.phase, text: s.text + d.text } : s;
    case "error": {
      const code = d.code === "briefing_failed" ? "briefing_failed" : "agent_failed";
      // fallback: the contract sends delta (fallback text) and done next, so the partial model text is dropped.
      return d.fallback === true
        ? { ...s, phase: "streaming", source: "fallback", text: "", error: null }
        : { ...s, phase: "error", error: { code, fallback: false } };
    }
    case "done":
      return { ...s, phase: "done", source: asSource(d.source) ?? s.source, cached: d.cached === true ? true : s.cached, error: null };
    default:
      return s;
  }
}

export interface BriefingLine {
  text: string;
  bullet: boolean;
}

/** Lines of the briefing text: bullets lose their "- " marker, empty lines vanish. Nothing is interpreted. */
export function briefingLines(text: string): BriefingLine[] {
  const out: BriefingLine[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^[-•*]\s+(.*)$/.exec(line);
    out.push(m ? { text: (m[1] ?? "").trim(), bullet: true } : { text: line, bullet: false });
  }
  return out.filter((l) => l.text !== "");
}

export type BriefingRun = { ok: true } | { ok: false; reason: "rate_limited" | "forbidden" | "failed" };

/**
 * Starts the briefing and feeds every SSE event to `onEvent`. Failures before the stream (JSON 401/403/429/500) and
 * a broken connection come back as a reason. A stream that ends without `done` or `error` is the caller's to judge.
 */
export async function runBriefing(deps: MutationDeps, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<BriefingRun> {
  const raw = await postApi("/api/briefing", deps, { signal });
  if (raw.kind !== "response") return { ok: false, reason: raw.kind };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason === "rate_limited" ? "rate_limited" : common.reason === "forbidden" ? "forbidden" : "failed" };
  if (!r.ok || r.body === null) return { ok: false, reason: "failed" };
  try {
    for await (const e of readSseEvents(r.body)) onEvent(e);
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
