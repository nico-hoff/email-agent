import { OPENROUTER_BASE_URL } from "./constants.ts";

type Env = Record<string, string | undefined>;

/**
 * O1a: Veryfront's OpenAI provider reads OPENAI_API_KEY / OPENAI_BASE_URL on every model resolution.
 * Derive them from OPENROUTER_API_KEY at server start, but only where they are not set already.
 * Never overwrites, never logs a value.
 */
export function applyOpenRouterEnv(env: Env = process.env): void {
  const key = env.OPENROUTER_API_KEY;
  // Only route to OpenRouter when the OpenRouter key is the one in use: an own OPENAI_API_KEY
  // must never be sent to openrouter.ai.
  if (env.OPENAI_API_KEY || !key) return;
  env.OPENAI_API_KEY = key;
  if (!env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = OPENROUTER_BASE_URL;
}
