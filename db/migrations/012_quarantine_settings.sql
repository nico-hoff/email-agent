ALTER TABLE mail_accounts ADD COLUMN quarantine_mode TEXT NOT NULL DEFAULT 'off' CHECK (quarantine_mode IN ('off', 'dry_run', 'live'));
ALTER TABLE mail_accounts ADD COLUMN quarantine_days INTEGER NOT NULL DEFAULT 14 CHECK (quarantine_days BETWEEN 1 AND 90);
ALTER TABLE mail_accounts ADD COLUMN quarantine_yolo INTEGER NOT NULL DEFAULT 0 CHECK (quarantine_yolo IN (0, 1));
