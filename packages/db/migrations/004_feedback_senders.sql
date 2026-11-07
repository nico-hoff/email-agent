CREATE TABLE feedback (
  id                INTEGER PRIMARY KEY,
  email_id          INTEGER NOT NULL REFERENCES emails (id),
  classification_id INTEGER REFERENCES classifications (id),
  kind              TEXT NOT NULL CHECK (kind IN ('spam_correct', 'not_spam', 'category_wrong', 'reply_needed', 'no_reply_needed')),
  value_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
  actor             TEXT NOT NULL CHECK (actor IN ('nico')),
  created_at        TEXT NOT NULL
);
CREATE INDEX feedback_email ON feedback (email_id, id DESC);

CREATE TABLE senders (
  id               INTEGER PRIMARY KEY,
  address          TEXT NOT NULL UNIQUE CHECK (address = lower(address)),
  domain           TEXT NOT NULL CHECK (domain = lower(domain)),
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  mails_seen       INTEGER NOT NULL DEFAULT 0 CHECK (mails_seen >= 0),
  marked_spam      INTEGER NOT NULL DEFAULT 0 CHECK (marked_spam >= 0),
  marked_not_spam  INTEGER NOT NULL DEFAULT 0 CHECK (marked_not_spam >= 0),
  jev_spam_count   INTEGER NOT NULL DEFAULT 0 CHECK (jev_spam_count >= 0),
  dmarc_pass       INTEGER NOT NULL DEFAULT 0 CHECK (dmarc_pass >= 0),
  hitl_asked_at    TEXT,
  hitl_asked_count INTEGER NOT NULL DEFAULT 0 CHECK (hitl_asked_count >= 0)
);
CREATE INDEX senders_domain ON senders (domain);

CREATE TABLE sender_rules (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('blacklist', 'allowlist')),
  match      TEXT NOT NULL CHECK (match IN ('address', 'domain')),
  value      TEXT NOT NULL CHECK (value = lower(value) AND length(value) BETWEEN 1 AND 254),
  account_id TEXT REFERENCES accounts (id),
  source     TEXT NOT NULL CHECK (source IN ('nico', 'suggested_confirmed')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX sender_rules_once ON sender_rules (kind, match, value, COALESCE(account_id, ''));
CREATE INDEX sender_rules_lookup ON sender_rules (match, value) WHERE active = 1;

INSERT INTO senders (address, domain, first_seen_at, last_seen_at, mails_seen)
SELECT lower(sender), substr(lower(sender), instr(sender, '@') + 1), MIN(first_seen_at), MAX(first_seen_at), COUNT(*)
FROM emails
WHERE instr(sender, '@') > 1 AND instr(sender, '@') < length(sender) AND sender NOT LIKE '%@%@%'
GROUP BY lower(sender);
