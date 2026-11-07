CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 20 AND 512),
  role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  status        TEXT NOT NULL CHECK (status IN ('unclaimed', 'active', 'disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (status = 'unclaimed' OR password_hash IS NOT NULL)
);

INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at)
VALUES (1, 'owner@unclaimed.invalid', NULL, 'admin', 'unclaimed',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE user_sessions (
  id           TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  user_id      INTEGER NOT NULL REFERENCES users (id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at   TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user ON user_sessions (user_id);

CREATE TABLE invites (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  role       TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  used_by    INTEGER REFERENCES users (id),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (used_by IS NULL))
);

ALTER TABLE accounts ADD COLUMN user_id INTEGER REFERENCES users (id);
UPDATE accounts SET user_id = 1;
CREATE UNIQUE INDEX accounts_id_user ON accounts (id, user_id);
CREATE INDEX accounts_user ON accounts (user_id);

CREATE TRIGGER accounts_user_required_insert BEFORE INSERT ON accounts
WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'accounts.user_id is required'); END;

CREATE TRIGGER accounts_user_required_update BEFORE UPDATE ON accounts
WHEN NEW.user_id IS NULL
BEGIN SELECT RAISE(ABORT, 'accounts.user_id is required'); END;

CREATE TABLE senders_new (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users (id),
  address          TEXT NOT NULL CHECK (address = lower(address)),
  domain           TEXT NOT NULL CHECK (domain = lower(domain)),
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  mails_seen       INTEGER NOT NULL DEFAULT 0 CHECK (mails_seen >= 0),
  marked_spam      INTEGER NOT NULL DEFAULT 0 CHECK (marked_spam >= 0),
  marked_not_spam  INTEGER NOT NULL DEFAULT 0 CHECK (marked_not_spam >= 0),
  jev_spam_count   INTEGER NOT NULL DEFAULT 0 CHECK (jev_spam_count >= 0),
  dmarc_pass       INTEGER NOT NULL DEFAULT 0 CHECK (dmarc_pass >= 0),
  hitl_asked_at    TEXT,
  hitl_asked_count INTEGER NOT NULL DEFAULT 0 CHECK (hitl_asked_count >= 0),
  UNIQUE (user_id, address)
);
INSERT INTO senders_new (id, user_id, address, domain, first_seen_at, last_seen_at, mails_seen, marked_spam, marked_not_spam, jev_spam_count, dmarc_pass, hitl_asked_at, hitl_asked_count)
SELECT id, 1, address, domain, first_seen_at, last_seen_at, mails_seen, marked_spam, marked_not_spam, jev_spam_count, dmarc_pass, hitl_asked_at, hitl_asked_count FROM senders;
DROP TABLE senders;
ALTER TABLE senders_new RENAME TO senders;
CREATE INDEX senders_domain ON senders (user_id, domain);

CREATE TABLE sender_rules_new (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  kind       TEXT NOT NULL CHECK (kind IN ('blacklist', 'allowlist')),
  match      TEXT NOT NULL CHECK (match IN ('address', 'domain')),
  value      TEXT NOT NULL CHECK (value = lower(value) AND length(value) BETWEEN 1 AND 254),
  account_id TEXT,
  source     TEXT NOT NULL CHECK (source IN ('nico', 'suggested_confirmed')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id, user_id) REFERENCES accounts (id, user_id)
);
INSERT INTO sender_rules_new (id, user_id, kind, match, value, account_id, source, active, created_at)
SELECT id, 1, kind, match, value, account_id, source, active, created_at FROM sender_rules;
DROP TABLE sender_rules;
ALTER TABLE sender_rules_new RENAME TO sender_rules;
CREATE UNIQUE INDEX sender_rules_once ON sender_rules (user_id, kind, match, value, COALESCE(account_id, ''));
CREATE INDEX sender_rules_lookup ON sender_rules (user_id, match, value) WHERE active = 1;

CREATE TABLE user_state_new (
  user_id    INTEGER NOT NULL REFERENCES users (id),
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO user_state_new (user_id, key, value_json, updated_at) SELECT 1, key, value_json, updated_at FROM user_state;
DROP TABLE user_state;
ALTER TABLE user_state_new RENAME TO user_state;

ALTER TABLE audit_log ADD COLUMN user_id INTEGER REFERENCES users (id);
