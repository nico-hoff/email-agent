CREATE TABLE push_subscriptions (
  id                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users (id),
  endpoint            TEXT NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 20 AND 1024 AND endpoint LIKE 'https://%'),
  p256dh              TEXT NOT NULL CHECK (length(p256dh) = 87 AND p256dh NOT GLOB '*[^A-Za-z0-9_-]*'),
  auth                TEXT NOT NULL CHECK (length(auth) = 22 AND auth NOT GLOB '*[^A-Za-z0-9_-]*'),
  agent_family        TEXT NOT NULL DEFAULT 'unknown' CHECK (length(agent_family) BETWEEN 1 AND 32 AND agent_family NOT GLOB '*[^A-Za-z0-9 ]*'),
  important_mail      INTEGER NOT NULL DEFAULT 1 CHECK (important_mail IN (0, 1)),
  briefing_ready      INTEGER NOT NULL DEFAULT 1 CHECK (briefing_ready IN (0, 1)),
  failure_count       INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_attempt_at     TEXT,
  created_at          TEXT NOT NULL,
  last_success_at     TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
