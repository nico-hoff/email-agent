import { fileURLToPath } from "node:url";

/** Project root = parent of lib/, independent of process.cwd(). */
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const EXCERPT_MAX_CHARS = 1200;
export const POLL_INTERVAL_MS = 300_000;
export const WATCHDOG_STALE_MS = 720_000;
export const IMAP_BACKOFF_MIN_MS = 1_000;
export const IMAP_BACKOFF_MAX_MS = 300_000;
export const JEV_RETRY_BACKOFF_MIN_MS = 30_000;
export const JEV_RETRY_BACKOFF_MAX_MS = 900_000;
export const JEV_MAX_ATTEMPTS = 8;
export const SCHEDULER_TICK_MS = 15_000;
export const SAMPLE_HARD_LIMIT = 400;
export const JEV_MODEL = "typesafe/jev-1.13";
export const QUESTION_SET_VERSION_V1 = "email-classification-v1";
export const QUESTION_SET_VERSION_V2 = "email-classification-v2";
/**
 * Question set for NEW classifications (pipeline, sample, dev database). Stays v1 until Nico has the v2 fixture
 * and a v2 calibration. To switch: set this to QUESTION_SET_VERSION_V2 and, in the same commit, add
 * config/noul-calibration.ts for v2 plus the matching docs/jev-contract.md table (a start-up check enforces both).
 * Callers that need a specific version use questionsFor(version) from jev-questions.ts and pass it explicitly.
 */
export const QUESTION_SET_VERSION = QUESTION_SET_VERSION_V1;
export const DEFAULT_ACCOUNTS_FILE = "data/accounts.json";
export const DEFAULT_DATABASE_PATH = "data/email-agent.sqlite";
export const DEV_SYNTHETIC_DATABASE_PATH = "data/dev-synthetic.sqlite";
/** Reply agent model (O1a): Veryfront OpenAI provider routed to OpenRouter; the model id itself is `openai/gpt-6-luna`. */
export const REPLY_DRAFTER_MODEL = "openai/openai/gpt-6-luna";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Provider flags (\Seen) are re-read for mails first seen within this window, at every poll (read-only FETCH FLAGS). */
export const FLAG_REFRESH_WINDOW_DAYS = 30;
/** UIDs per FETCH FLAGS command. */
export const FLAG_REFRESH_CHUNK = 200;
