CREATE TABLE mail_accounts (
  account_id        TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('imap', 'google')),
  tls               INTEGER NOT NULL CHECK (tls IN (0, 1)),
  username          TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 254),
  secret_ciphertext BLOB NOT NULL CHECK (length(secret_ciphertext) BETWEEN 1 AND 2048),
  secret_nonce      BLOB NOT NULL CHECK (length(secret_nonce) = 12),
  secret_tag        BLOB NOT NULL CHECK (length(secret_tag) = 16),
  key_id            TEXT NOT NULL CHECK (length(key_id) = 16 AND key_id NOT GLOB '*[^0-9a-f]*'),
  secret_set_at     TEXT NOT NULL,
  last_test_at      TEXT,
  last_test_code    TEXT CHECK (last_test_code IS NULL OR (length(last_test_code) BETWEEN 1 AND 32 AND last_test_code NOT GLOB '*[^a-z_]*')),
  context           TEXT NOT NULL DEFAULT '' CHECK (length(context) <= 2000),
  spam_threshold    REAL NOT NULL DEFAULT 0.95 CHECK (spam_threshold BETWEEN 0 AND 1),
  spam_seen_mode    TEXT NOT NULL DEFAULT 'off' CHECK (spam_seen_mode IN ('off', 'dry_run', 'live')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (account_id, user_id) REFERENCES accounts (id, user_id)
);
CREATE INDEX mail_accounts_user ON mail_accounts (user_id);
