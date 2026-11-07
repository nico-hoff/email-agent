CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  mailbox      TEXT NOT NULL,
  spam_mailbox TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE mailbox_state (
  account_id   TEXT NOT NULL REFERENCES accounts (id),
  mailbox      TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  last_uid     INTEGER NOT NULL CHECK (last_uid >= 0),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (account_id, mailbox)
);

CREATE TABLE worker_status (
  account_id    TEXT PRIMARY KEY REFERENCES accounts (id),
  state         TEXT NOT NULL CHECK (state IN ('disabled', 'connecting', 'connected', 'backoff', 'paused')),
  error_code    TEXT,
  last_event_at TEXT,
  last_poll_at  TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE emails (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  message_id    TEXT,
  sender        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  UNIQUE (account_id, message_id),
  UNIQUE (id, account_id)
);
CREATE INDEX emails_account_received ON emails (account_id, received_at DESC);

CREATE TABLE email_locations (
  id            INTEGER PRIMARY KEY,
  email_id      INTEGER NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  folder        TEXT NOT NULL,
  uid_validity  INTEGER NOT NULL,
  uid           INTEGER NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  FOREIGN KEY (email_id, account_id) REFERENCES emails (id, account_id),
  UNIQUE (account_id, folder, uid_validity, uid)
);
CREATE INDEX email_locations_email ON email_locations (email_id);

CREATE TABLE classifications (
  id                   INTEGER PRIMARY KEY,
  email_id             INTEGER NOT NULL REFERENCES emails (id),
  question_set_version TEXT NOT NULL,
  model_requested      TEXT NOT NULL,
  model_reported       TEXT,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'classified', 'failed', 'paused')),
  failure_code         TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at      TEXT,
  latency_ms           INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (email_id, question_set_version, model_requested),
  CHECK (status <> 'classified' OR model_reported IS NOT NULL),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL)
);
CREATE INDEX classifications_due ON classifications (next_attempt_at) WHERE status = 'retry_wait';

CREATE TABLE classification_answers (
  id                 INTEGER PRIMARY KEY,
  classification_id  INTEGER NOT NULL REFERENCES classifications (id),
  question_key       TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('noul', 'choice', 'score', 'derived')),
  answer_json        TEXT NOT NULL CHECK (json_valid(answer_json)),
  probabilities_json TEXT CHECK (probabilities_json IS NULL OR json_valid(probabilities_json)),
  UNIQUE (classification_id, question_key)
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  occurred_at  TEXT NOT NULL,
  trace_id     TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('worker', 'pipeline', 'sample', 'eval', 'system')),
  action       TEXT NOT NULL,
  account_id   TEXT REFERENCES accounts (id),
  email_id     INTEGER REFERENCES emails (id),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);
CREATE INDEX audit_log_time ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_email ON audit_log (email_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
