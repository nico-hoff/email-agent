import { OpenRouterCore } from "@openrouter/sdk/core.js";
import { systemOneCreate as sdkSystemOneCreate } from "@openrouter/sdk/funcs/systemOneCreate.js";
import type { DecisionsResponse } from "@openrouter/sdk/models";
import { JEV_MODEL } from "./constants.ts";
import type { JevQuestion } from "./jev-questions.ts";
import { createLimiter, type Limiter } from "./limiter.ts";

export type JevCallResult =
  | { ok: true; response: DecisionsResponse }
  | { ok: false; kind: "http" | "transport"; statusCode?: number; errorName: string };

export type JevClientOptions = {
  apiKey: string;
  client?: OpenRouterCore;
  systemOneCreate?: typeof sdkSystemOneCreate;
  limiter?: Limiter;
  timeoutMs?: number;
};

export type JevClient = {
  classify(input: { questions: Record<string, JevQuestion>; state: Record<string, unknown> }): Promise<JevCallResult>;
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

export function createJevClient(options: JevClientOptions): JevClient {
  const client = options.client ?? new OpenRouterCore({
    apiKey: options.apiKey,
    appTitle: "email-agent",
    retryConfig: { strategy: "none" },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const call = options.systemOneCreate ?? sdkSystemOneCreate;
  const limit = options.limiter ?? createLimiter(1);

  return {
    classify({ questions, state }) {
      return limit(async (): Promise<JevCallResult> => {
        try {
          const res = await call(client, {
            decisionsRequest: { model: JEV_MODEL, questions, state },
          }, { retries: { strategy: "none" } });
          if (!res || typeof res !== "object") {
            return { ok: false, kind: "transport", errorName: "InvalidResult" };
          }
          if (!res.ok) {
            const statusCode = statusOf(res.error);
            return statusCode === undefined
              ? { ok: false, kind: "transport", errorName: errorName(res.error) }
              : { ok: false, kind: "http", statusCode, errorName: errorName(res.error) };
          }
          if (!res.value) return { ok: false, kind: "transport", errorName: "EmptyResult" };
          return { ok: true, response: res.value };
        } catch (e) {
          return { ok: false, kind: "transport", errorName: errorName(e) };
        }
      });
    },
  };
}
