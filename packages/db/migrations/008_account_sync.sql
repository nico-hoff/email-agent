CREATE TABLE account_sync (
  account_id  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('queued', 'connecting', 'fetching', 'classifying', 'done', 'failed')),
  total       INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  fetched     INTEGER NOT NULL DEFAULT 0 CHECK (fetched >= 0),
  classified  INTEGER NOT NULL DEFAULT 0 CHECK (classified >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_code  TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 32 AND error_code NOT GLOB '*[^a-z_]*')),
  runs        INTEGER NOT NULL DEFAULT 1 CHECK (runs >= 1),
  started_at  TEXT,
  updated_at  TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (account_id, user_id) REFERENCES accounts (id, user_id)
);
CREATE INDEX account_sync_user ON account_sync (user_id);
ALTER TABLE emails ADD COLUMN origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'import'));
