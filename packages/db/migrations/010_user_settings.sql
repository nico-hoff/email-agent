CREATE TABLE user_settings (
  user_id                 INTEGER PRIMARY KEY REFERENCES users (id),
  classifier_choice       INTEGER NOT NULL DEFAULT 0 CHECK (classifier_choice IN (0, 1)),
  classifier_model        TEXT CHECK (classifier_model IS NULL OR (length(classifier_model) BETWEEN 3 AND 64 AND classifier_model NOT GLOB '*[^a-z0-9./_-]*')),
  auto_actions_stopped_at TEXT,
  updated_at              TEXT NOT NULL
);
