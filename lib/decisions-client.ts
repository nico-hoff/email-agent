// Dünner Client fuer die OpenRouter-Decisions-API (`alphaDecisionsCreate`, Modelle wie `openai/gpt-6-luna-decisions`).
// Request und Response haben dieselbe Form wie System One (`DecisionsRequest` / `DecisionsResponse`: state + Fragen
// vom Typ noul/choice/score, Antworten unter `answers`), daher ist der Adapter klein: gleiche JevCallResult-Form,
// gleiche JevQuestion-Typen, gleiche Normalisierung (`normalizeAnswers`). Nur fuer den Modellvergleich
// (scripts/model-compare.ts); die Produktions-Pipeline bleibt bei Jev (lib/jev.ts).
import { OpenRouterCore } from "@openrouter/sdk/core.js";
import { alphaDecisionsCreate as sdkAlphaDecisionsCreate } from "@openrouter/sdk/funcs/alphaDecisionsCreate.js";
import { systemOneCreate as sdkSystemOneCreate } from "@openrouter/sdk/funcs/systemOneCreate.js";
import type { DecisionsResponse } from "@openrouter/sdk/models";
import type { JevCallResult, JevClient } from "./jev.ts";
import { createLimiter, type Limiter } from "./limiter.ts";

export const LUNA_DECISIONS_MODEL = "openai/gpt-6-luna-decisions";

type CreateFn = typeof sdkAlphaDecisionsCreate | typeof sdkSystemOneCreate;

export type DecisionsClientOptions = {
  apiKey: string;
  model: string;
  /** "decisions" = /api/alpha/decisions (Standard), "systemone" = /systemone. */
  endpoint?: "decisions" | "systemone";
  client?: OpenRouterCore;
  create?: CreateFn;
  limiter?: Limiter;
  timeoutMs?: number;
};

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "UnknownError";
}

function statusOf(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "statusCode" in e) {
    const s = (e as { statusCode: unknown }).statusCode;
    if (typeof s === "number" && Number.isInteger(s)) return s;
  }
  return undefined;
}

export function createDecisionsClient(options: DecisionsClientOptions): JevClient {
  const client = options.client ?? new OpenRouterCore({
    apiKey: options.apiKey,
    appTitle: "email-agent",
    retryConfig: { strategy: "none" },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const call: CreateFn = options.create ?? (options.endpoint === "systemone" ? sdkSystemOneCreate : sdkAlphaDecisionsCreate);
  const limit = options.limiter ?? createLimiter(1);

  return {
    classify({ questions, state }) {
      return limit(async (): Promise<JevCallResult> => {
        try {
          const res = await call(client, {
            decisionsRequest: { model: options.model, questions, state },
          }, { retries: { strategy: "none" } });
          if (!res || typeof res !== "object") return { ok: false, kind: "transport", errorName: "InvalidResult" };
          if (!res.ok) {
            const statusCode = statusOf(res.error);
            return statusCode === undefined
              ? { ok: false, kind: "transport", errorName: errorName(res.error) }
              : { ok: false, kind: "http", statusCode, errorName: errorName(res.error) };
          }
          if (!res.value) return { ok: false, kind: "transport", errorName: "EmptyResult" };
          return { ok: true, response: res.value as DecisionsResponse };
        } catch (e) {
          return { ok: false, kind: "transport", errorName: errorName(e) };
        }
      });
    },
  };
}
