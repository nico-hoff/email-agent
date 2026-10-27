CREATE TABLE email_status (
  email_id   INTEGER PRIMARY KEY REFERENCES emails (id),
  seen       INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0, 1)),
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  updated_at TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN color TEXT
  CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
