CREATE TABLE mailbox_actions (
  id           INTEGER PRIMARY KEY,
  email_id     INTEGER NOT NULL REFERENCES emails (id),
  location_id  INTEGER NOT NULL REFERENCES email_locations (id),
  rule         TEXT NOT NULL CHECK (rule IN ('spam_seen', 'blacklist', 'quarantine', 'purge', 'undo')),
  action       TEXT NOT NULL CHECK (action IN ('mark_seen', 'move_quarantine', 'move_trash', 'move_inbox', 'unmark_seen')),
  mode         TEXT NOT NULL CHECK (mode IN ('dry_run', 'live')),
  status       TEXT NOT NULL CHECK (status IN ('planned', 'done', 'failed', 'undone')),
  failure_code TEXT,
  reason_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(reason_json)),
  created_at   TEXT NOT NULL,
  done_at      TEXT,
  CHECK ((rule = 'undo') = (action IN ('move_inbox', 'unmark_seen'))),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL)
);
CREATE UNIQUE INDEX mailbox_actions_once ON mailbox_actions (email_id, rule) WHERE rule <> 'undo';
CREATE INDEX mailbox_actions_list ON mailbox_actions (mode, created_at DESC, id DESC);
