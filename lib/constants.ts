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
 * Question set for NEW classifications (pipeline, sample, dev database): v2 since R7 (ADR 0032; calibration v2 in
 * config/noul-calibration.ts plus the table in docs/jev-contract.md, a start-up check enforces both). Stored v1
 * classifications keep their v1 reading. Callers that need a specific version use questionsFor(version) from
 * jev-questions.ts and pass it explicitly.
 */
export const QUESTION_SET_VERSION = QUESTION_SET_VERSION_V2;
export const DEFAULT_ACCOUNTS_FILE = "data/accounts.json";
export const DEFAULT_DATABASE_PATH = "data/email-agent.sqlite";
export const DEV_SYNTHETIC_DATABASE_PATH = "data/dev-synthetic.sqlite";
/** Reply agent model (O1a): Veryfront OpenAI provider routed to OpenRouter; the model id itself is `openai/gpt-6-luna`. */
export const REPLY_DRAFTER_MODEL = "openai/openai/gpt-6-luna";
/** Briefing agent (Plan v5 E6): same model as the reply agent. */
export const BRIEFING_MODEL = REPLY_DRAFTER_MODEL;
/** The same briefing is served from memory for this long (Plan v5 D28). */
export const BRIEFING_CACHE_MS = 5 * 60 * 1000;
/** Hard stop for one briefing stream. */
export const BRIEFING_TIMEOUT_MS = 30_000;
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Provider flags (\Seen) are re-read for mails first seen within this window, at every poll (read-only FETCH FLAGS). */
export const FLAG_REFRESH_WINDOW_DAYS = 30;
/** UIDs per FETCH FLAGS command. */
export const FLAG_REFRESH_CHUNK = 200;
/** Automatic mailbox actions (M7a): global kill switch file (in the data directory, next to the database). */
export const KILL_SWITCH_FILE = "auto-actions.disabled";
/** Live actions per account in a rolling 24 hours; further mails wait (no row) until the window frees up. */
export const DAILY_ACTION_LIMIT = 200;
/** One-time pass over already classified mails at start-up: newest first, only recent mails. */
export const BACKFILL_LIMIT = 1000;
export const BACKFILL_WINDOW_DAYS = 14;
