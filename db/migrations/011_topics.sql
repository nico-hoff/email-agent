ALTER TABLE classifications ADD COLUMN topic_list_version TEXT CHECK (topic_list_version IS NULL OR (length(topic_list_version) BETWEEN 8 AND 40 AND topic_list_version NOT GLOB '*[^a-z0-9-]*'));

ALTER TABLE user_settings ADD COLUMN topics_enabled INTEGER NOT NULL DEFAULT 0 CHECK (topics_enabled IN (0, 1));

CREATE TABLE user_topics (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  key        TEXT NOT NULL CHECK (key GLOB 'custom_*' AND length(key) BETWEEN 8 AND 40 AND key NOT GLOB '*[^a-z0-9_]*'),
  label      TEXT NOT NULL CHECK (length(label) BETWEEN 2 AND 40),
  hint       TEXT CHECK (hint IS NULL OR length(hint) <= 120),
  position   INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, key)
);
CREATE INDEX user_topics_user ON user_topics (user_id, active, position);
