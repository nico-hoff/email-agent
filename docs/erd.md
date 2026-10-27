# E-Mail-Agent – Datenmodell (ERD + DDL)

Quelle der Wahrheit für das SQLite-Schema. Jede Migration `db/migrations/NNN_*.sql` enthält den DDL-Block ihres Abschnitts „DDL“ in diesem Dokument **wörtlich**; ein Test vergleicht beides (siehe unten). Das Schema speichert ausschließlich Metadaten, Klassifikationsantworten und Betriebszustand – nie Mailinhalte.

## ERD

```mermaid
erDiagram
  accounts ||--o{ mailbox_state : "Checkpoint je Ordner"
  accounts ||--o| worker_status : "Betriebszustand"
  accounts ||--o{ emails : empfaengt
  emails ||--|{ email_locations : "liegt in Ordner"
  emails ||--o| email_status : "gelesen / erledigt"
  emails ||--o{ classifications : "Lauf je Fragenset"
  emails ||--o{ mailbox_actions : "Postfach-Aktion"
  emails ||--o{ feedback : "Nicos Rückmeldung"
  classifications |o--o{ feedback : "bezieht sich auf"
  accounts |o--o{ sender_rules : "optional je Konto"
  email_locations ||--o{ mailbox_actions : "Ziel der Aktion"
  classifications ||--o{ classification_answers : Antworten
  accounts |o--o{ audit_log : betrifft
  emails |o--o{ audit_log : betrifft

  accounts {
    text id PK
    text label
    text host
    integer port
    text mailbox
    text spam_mailbox
    integer enabled
    text color
  }
  mailbox_state {
    text account_id PK, FK
    text mailbox PK
    integer uid_validity
    integer last_uid
    text updated_at
  }
  worker_status {
    text account_id PK, FK
    text state
    text error_code
    text last_event_at
    text last_poll_at
    text updated_at
  }
  emails {
    integer id PK
    text account_id FK
    text message_id UK
    text sender
    text subject
    text received_at
    text first_seen_at
  }
  email_status {
    integer email_id PK, FK
    integer seen
    integer done
    text updated_at
  }
  email_locations {
    integer id PK
    integer email_id FK
    text account_id FK
    text folder UK
    integer uid_validity UK
    integer uid UK
    integer is_active
    text first_seen_at
    text last_seen_at
  }
  classifications {
    integer id PK
    integer email_id FK
    text question_set_version UK
    text model_requested UK
    text model_reported
    text status
    text failure_code
    integer attempts
    text next_attempt_at
    integer latency_ms
    text created_at
    text updated_at
  }
  classification_answers {
    integer id PK
    integer classification_id FK
    text question_key UK
    text type
    text answer_json
    text probabilities_json
  }
  mailbox_actions {
    integer id PK
    integer email_id FK
    integer location_id FK
    text rule
    text action
    text mode
    text status
    text failure_code
    text reason_json
    text created_at
    text done_at
  }
  user_state {
    text key PK
    text value_json
    text updated_at
  }
  feedback {
    integer id PK
    integer email_id FK
    integer classification_id FK
    text kind
    text value_json
    text actor
    text created_at
  }
  senders {
    integer id PK
    text address UK
    text domain
    text first_seen_at
    text last_seen_at
    integer mails_seen
    integer marked_spam
    integer marked_not_spam
    integer jev_spam_count
    integer dmarc_pass
    text hitl_asked_at
    integer hitl_asked_count
  }
  sender_rules {
    integer id PK
    text kind
    text match
    text value
    text account_id FK
    text source
    integer active
    text created_at
  }
  audit_log {
    integer id PK
    text occurred_at
    text trace_id
    text actor
    text action
    text account_id FK
    integer email_id FK
    text details_json
  }
```

Mermaid kann zusammengesetzte Eindeutigkeit nicht gruppieren. Maßgeblich sind die `UNIQUE (...)`-Klauseln im DDL unten:

- `emails`: `UNIQUE (account_id, message_id)` und `UNIQUE (id, account_id)` (Elternschlüssel für den zusammengesetzten FK).
- `email_locations`: `UNIQUE (account_id, folder, uid_validity, uid)`.
- `classifications`: `UNIQUE (email_id, question_set_version, model_requested)`.
- `classification_answers`: `UNIQUE (classification_id, question_key)`.
- `mailbox_actions`: partieller Unique-Index `(email_id, rule) WHERE rule <> 'undo'` (je Mail und Regel höchstens eine Aktion; Undo-Zeilen dürfen sich wiederholen).
- `sender_rules`: Unique-Index `(kind, match, value, COALESCE(account_id, ''))` (ein Ausdrucksindex, damit auch Regeln ohne Konto nicht doppelt vorkommen; SQLite behandelt NULL in UNIQUE sonst als verschieden).

## Entwurfsentscheidungen

1. **Logische Mail und Ort getrennt.** `emails` ist die Mail (Message-ID), `email_locations` ist ihr Platz in einem Ordner (UID/UIDVALIDITY gelten pro Ordner). Verschiebt der Provider eine Mail später von INBOX in den Spam-Ordner, kommt eine neue Location hinzu, die alte wird `is_active = 0`, und `audit_log` bekommt `folder_changed`. Kein Crash an einer globalen UNIQUE-Klausel, und die Klassifikation hängt an der logischen Mail.
2. **Mail ohne Message-ID** bekommt trotzdem eine `emails`-Zeile (`message_id` NULL; SQLite erlaubt mehrere NULLs in UNIQUE). Ihre Identität ist dann die Location.
3. **Zusammengesetzter FK** `(email_id, account_id) → emails (id, account_id)` stellt sicher, dass eine Location nie zu einem anderen Konto gehört als ihre Mail.
4. **Antworten normalisiert** in `classification_answers` statt fester Spalten. Ändert sich das Fragenset, ändert sich nur `question_set_version`, nicht das Schema. Abgeleitete Werte (z. B. `shadow_quarantine`) stehen dort mit `type = 'derived'`.
5. **`audit_log` ist append-only**, per Trigger erzwungen. Es nimmt auch Mail-Lebenszyklusereignisse auf (`folder_changed`, `source_gone`, `uidvalidity_reset`); eine eigene Tabelle `email_events` gibt es nicht.
6. **`worker_status` liegt in der DB.** Veryfront-Routen und CLI-Prozesse (`sample`, `eval`) teilen keinen Arbeitsspeicher mit `server.ts`. Routen lesen Betriebszustand deshalb nur aus SQLite.
7. **Kein Schwellwert in der DB.** `spam_threshold` kommt aus der Konten-JSON; der je Lauf angewandte Wert steht in der abgeleiteten Antwort.
8. **Zeitstempel** sind ISO-8601 UTC als TEXT (`2026-10-26T19:48:46.692Z`).
9. **Keine Inhaltsspalten.** Kein Body, Auszug, Rohquelle, Header-Rohdaten, Anhang oder Roh-Response. Absender (nur Adresse, kleingeschrieben) und Betreff sind die einzigen Mailinhalte in der DB; sie dürfen nie in Logs.
10. **Lese- und Erledigt-Status getrennt von der Mail (002).** `email_status` hat höchstens eine Zeile je Mail. `seen` kommt ausschließlich vom Provider (IMAP-Flag `\Seen`, nur gelesen, nie geschrieben); `done` setzt allein Nico in der App (nur App-DB). Eine fehlende Zeile bedeutet `seen = 0, done = 0`. Beide Werte sind unabhängig: Der Worker überschreibt nie `done`, die App nie `seen`. „Offen“ ist keine Spalte, sondern eine reine Funktion (Plan v5, 3.6).
11. **Kontofarbe in der DB (002).** `accounts.color` (`#rrggbb`, klein geschrieben, optional) wird beim Start wie `label` aus der Konten-Datei synchronisiert. Dadurch muss die API nie die Konten-Datei (mit Zugangsdaten) lesen, und der synthetische Modus hat Farben. Abweichung von Plan v5 D29 („kein Schema nötig“), begründet in `docs/DEVIATIONS.md`.
12. **Audit der App-Aktionen.** `email_done` und `email_undone` stehen mit `actor = 'system'` im `audit_log` (nur `email_id` und `account_id`, `details_json` leer). Ein eigener Akteur `nico` kommt erst mit der Rebuild-Migration von `audit_log` (Plan v5, Abschnitt 4), nicht vorher.

13. **Postfach-Aktionen (003, M7a).** `mailbox_actions` protokolliert jede automatische Schreibaktion auf dem Mailserver und jede, die nur geplant wäre (Trockenlauf). Sie speichert nur IDs, Codes und Zeitstempel; `reason_json` enthält nur kurze Codes und Zahlen (z. B. `{"rule_reason":"jev_spam"}`), nie Betreff, Absender oder Inhalt. `location_id` ist der aktive Ort der Mail zum Zeitpunkt der Aktion (Ordner, UIDVALIDITY und UID stehen dort). Die CHECK-Listen enthalten schon die Werte von M7 (`blacklist`, `quarantine`, `purge`, `move_*`), weil eine CHECK-Liste in SQLite nur per Tabellenumbau erweiterbar ist; M7a nutzt nur `rule` ∈ {`spam_seen`, `undo`} und `action` ∈ {`mark_seen`, `unmark_seen`}. Die Paarung ist per CHECK erzwungen (`undo` gehört zu `unmark_seen`/`move_inbox`, alle anderen Regeln zu den übrigen Aktionen). Status: `planned` (nur Trockenlauf), `done`, `failed` (mit `failure_code`), `undone` (die ursprüngliche Aktion wurde per Undo zurückgenommen). Der partielle Unique-Index macht die Ausführung idempotent und verhindert, dass eine zurückgenommene Aktion erneut greift. Die Migration trägt die Nummer 003, weil Plan v5 (Abschnitt 4) die geplante Migration `003` für Feedback/Absender (M5) erst später baut; diese wird `004`.
14. **Audit der Postfach-Aktionen.** `mailbox_action` steht mit `actor = 'system'` im `audit_log` (`details_json` nur mit `action_id`, `rule`, `action`, `mode`, `status`, `failure_code`). Ein eigener Akteur `rules` kommt erst mit der Rebuild-Migration von `audit_log` (zusammen mit `nico`).

15. **App-Zustand (005, M6).** `user_state` ist ein kleiner Schlüssel-Wert-Speicher für Zustand der App selbst, der zu keiner Mail gehört. Erster Schlüssel: `last_opened_at` (`{"at":"<ISO-8601 UTC>"}`), gesetzt, wenn das Briefing erzeugt wurde; er begrenzt die Zähler „neu seit dem letzten Öffnen“. `value_json` enthält nur Zeitstempel, Zahlen und kurze Codes, nie Text aus Mails, Briefings oder Entwürfen. Die Migration trägt die Nummer 005, weil 004 für die Feedback-/Absender-Tabellen (M5) reserviert ist; sie hängt von keiner dieser Tabellen ab. Das Briefing selbst wird nicht gespeichert (D28).
16. **Audit des Briefings.** `briefing_generated` steht mit `actor = 'system'` im `audit_log`, ohne `email_id`; `details_json` enthält nur Modell, Latenz, Tokenzahlen und die Anzahl der Mails im Kontext (`mails`). Entwürfe: `draft_generated` (ohne Text).
17. **Feedback, Absender und Absender-Regeln (004, M5).** `feedback` ist ein Anhängeprotokoll von Nicos Rückmeldungen je Mail (`kind` aus fünf festen Werten; `value_json` nur ein kurzer Code, z. B. `{"category":"business"}` bei `category_wrong`; nie Freitext). `actor` ist hier immer `nico`, weil es eine eigene Tabelle ist. Ein Klick, der den letzten Stand desselben Themas (Spam-Urteil, Antwortbedarf, Kategorie) wiederholt, legt keine zweite Zeile an. `senders` führt je Adresse (klein geschrieben, nur die Adresse, nie Betreff oder Name) Zähler: `mails_seen`, `dmarc_pass` (Mails mit bestandenem DMARC), `jev_spam_count` (Mails, die Jev bei der ersten Klassifikation als Spam urteilte, Schwelle aus der Kalibrierung), `marked_spam` und `marked_not_spam` (Nicos jeweils letztes Urteil je Mail). Die Migration füllt `senders` aus den vorhandenen Mails (`mails_seen`, erster und letzter Zeitpunkt); die anderen Zähler beginnen bei 0.
18. **HITL-Marker (004).** `hitl_asked_at` und `hitl_asked_count` merken, wann Nico gefragt wurde und wie hoch `jev_spam_count` damals war. Ein Absender wird erst wieder Kandidat, wenn `jev_spam_count` darüber liegt (Plan v5, E7: „noch nicht gefragt oder seit der Frage weitere Urteile“). Plan v5, Abschnitt 4, hatte nur `hitl_asked_at`; ohne den Zählerstand lässt sich „seitdem weitere Urteile“ nicht entscheiden (Abweichung, `docs/DEVIATIONS.md`). Bei Domain-Vorschlägen gilt die Summe über alle Adressen der Domain.
19. **`sender_rules` (004).** Eine Regel gilt für eine Adresse oder eine Domain (`match`), optional für ein Konto (`account_id`), dauerhaft, bis Nico sie deaktiviert (`active = 0`; Zeilen werden nie gelöscht, die Eindeutigkeit bleibt erhalten, ein erneutes Anlegen aktiviert die Zeile wieder). `source` ist `nico` (Nicos ausdrückliche Entscheidung); `suggested_confirmed` ist für spätere, vom Agenten vorgeschlagene und von Nico bestätigte Regeln reserviert. Ein aktiver Eintrag je Ziel: Legt Nico die Gegenregel an, wird die bisherige im selben Schritt deaktiviert. `value` ist kleingeschrieben (Adresse oder Domain).
20. **Audit der Rückmeldungen und Regeln (004).** `feedback_recorded`, `sender_rule_created`, `sender_rule_deactivated` und `sender_hitl_dismissed` stehen mit `actor = 'system'` im `audit_log`; `details_json.source = 'nico'` hält die Herkunft fest, weil ein neuer Akteur `nico` den Umbau der append-only-Tabelle verlangt (siehe Nr. 12 und 14). `details_json` enthält nur IDs und Codes (`kind`, `match`, `rule_id`), nie Adressen, Domains oder Betreffs.

## Verbindungs-Pragmas (nicht Teil der Migration, bei jeder Verbindung setzen)

```text
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Der Migrationsrunner legt `schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)` selbst an (`CREATE TABLE IF NOT EXISTS`) und führt `db/migrations/NNN_*.sql` numerisch sortiert und einmalig aus.

## DDL (`db/migrations/001_init.sql`)

```sql
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
```

`audit_log.action` ist bewusst frei erweiterbar; im Code gibt es dafür einen Union-Typ. Vorgesehene Werte: `worker_connected`, `worker_backoff`, `worker_paused`, `worker_reconnect_forced`, `uidvalidity_reset`, `folder_changed`, `source_gone`, `classification_failed`, `jev_paused`, `shadow_quarantine_computed`, `sample_previewed`, `sample_started`, `sample_finished`, `eval_run`. `details_json` enthält nur IDs, Codes, Zähler und Ordnernamen, nie Betreff, Absender, Body oder Credentials.

## DDL (`db/migrations/002_status_and_account_color.sql`)

```sql
CREATE TABLE email_status (
  email_id   INTEGER PRIMARY KEY REFERENCES emails (id),
  seen       INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0, 1)),
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  updated_at TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN color TEXT
  CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'));
```

`audit_log.action` kennt zusätzlich `email_done` und `email_undone`.

## DDL (`db/migrations/003_mailbox_actions.sql`)

```sql
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
```

`audit_log.action` kennt zusätzlich `mailbox_action`.

## DDL (`db/migrations/004_feedback_senders.sql`)

```sql
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
```

`audit_log.action` kennt zusätzlich `feedback_recorded`, `sender_rule_created`, `sender_rule_deactivated` und `sender_hitl_dismissed`.

## DDL (`db/migrations/005_user_state.sql`)

```sql
CREATE TABLE user_state (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);
```

`audit_log.action` kennt zusätzlich `briefing_generated` und `draft_generated`.

## Schema-Test (`tests/db.test.ts`)

- Jeder Abschnitt „## DDL (`db/migrations/NNN_name.sql`)“ hat genau einen SQL-Codeblock, der nach Whitespace-Normalisierung identisch mit der benannten Migrationsdatei ist; jede Migrationsdatei hat einen solchen Abschnitt (der Pragma-Block ist bewusst als `text` ausgezeichnet und gehört nicht dazu).
- Die Spaltenmenge jeder Tabelle (`PRAGMA table_info`) entspricht einer Allowlist im Test. Kein Spaltenname passt auf `/(^|_)(body|snippet|excerpt|raw|attachment|html|content|spam_threshold)($|_)/i`.
- FK-Verstöße, zusammengesetzter FK (Location eines fremden Kontos), alle UNIQUE- und CHECK-Klauseln, `json_valid`-Checks und beide Append-only-Trigger werden mit je einem Verstoß-Test belegt.
- Die drei Pragmas sind auf **jeder** geöffneten Verbindung aktiv.
