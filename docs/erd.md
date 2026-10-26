# Email ERD

´´´mermaid
erDiagram
  accounts ||--o{ mailbox_state : "Checkpoint je Ordner"
  accounts ||--o{ emails : empfaengt
  emails ||--o{ email_events : "Ordnerwechsel"
  emails ||--o{ classifications : "Laeufe"
  classifications ||--o{ classification_answers : Antworten
  accounts ||--o{ audit_log : protokolliert
  emails |o--o{ audit_log : betrifft

  accounts {
    text id PK
    text label
    text host
    integer port
    integer enabled
  }
  mailbox_state {
    text account_id PK, FK
    text mailbox PK
    integer uid_validity
    integer last_uid
    text updated_at
  }
  emails {
    integer id PK
    text account_id FK
    text message_id UK
    text folder UK
    integer uid UK
    integer uid_validity UK
    text sender
    text subject
    text received_at
    text first_seen_at
  }
  email_events {
    integer id PK
    integer email_id FK
    text event_type
    text from_folder
    text to_folder
    text occurred_at
  }
  classifications {
    integer id PK
    integer email_id FK
    text model
    text question_set_version
    integer latency_ms
    integer attempts
    text next_attempt_at
    text status
    text created_at
    text updated_at
  }
  classification_answers {
    integer id PK
    integer classification_id FK
    text question_key
    text type
    text answer_json
    text probabilities_json
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

Ein paar Anmerkungen:

Schlüssel: mailbox_state hat den zusammengesetzten Primärschlüssel (account_id, mailbox). Bei emails gilt UNIQUE(account_id, folder, uid_validity, uid) und zusätzlich UNIQUE(account_id, message_id) als Upsert-Ziel. Der Markdown-Rand in Mermaid kann mehrere UK-Spalten nicht gruppieren, die Gruppierung gehört deshalb ins DDL.
classification_answers.email_id entfällt. Im Plan steht die Spalte neben classification_id, das ist redundant und kann inkonsistent werden. Den Weg zur Mail gibt der Join über classifications.
audit_log ist neu: Der Plan hat sie komplett gestrichen, dein Blueprint sah sie append-only vor. Auch im Shadow-Modus gibt es Ereignisse, die ins Log gehören (Worker pausiert, Reconnect, UIDVALIDITY-Reset, would_quarantine berechnet). Ohne personenbezogene Daten, details_json enthält nur IDs und Gründe.
Wo es hingehört: docs/erd.md als Quelle der Wahrheit, plus das vollständige DDL wörtlich in Task 4. Der vorhandene Schema-Test prüft dann die exakte Spaltenmenge, damit nie ein body- oder snippet-Feld hineinrutscht.