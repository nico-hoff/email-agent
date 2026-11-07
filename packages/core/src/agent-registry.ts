// Access to the agents Veryfront discovered at server start (Context7 /websites/veryfront, agents guide:
// `getAgent(id)` returns `Agent | undefined`; the id is derived from the file name in agents/). Imported lazily so
// modules that are loaded by tests or scripts never pull in the framework.

/** Agent for `id` (camelCase of the file name, e.g. "replyDrafter" for agents/reply-drafter.ts), or undefined. */
export async function resolveAgent<T>(id: string): Promise<T | undefined> {
  try {
    const { getAgent } = await import("veryfront/agent");
    return getAgent(id) as unknown as T | undefined;
  } catch {
    return undefined;
  }
}

/** True when a model key is available. applyOpenRouterEnv (server start) derives OPENAI_API_KEY from OPENROUTER_API_KEY. */
export function hasModelKey(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY);
}
