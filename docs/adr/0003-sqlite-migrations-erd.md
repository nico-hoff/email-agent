# 0003 SQLite, nummerierte Migrationen, ERD als Wahrheit

- Status: angenommen
- Datum: 2026-10-20 (fly-Bestätigung 2026-10-31)
- Bezug: `docs/erd.md`, `db/migrations/001`–`005`, `lib/db.ts`, Schema-Tests

## Kontext
Ein Nutzer, wenig Daten (nur Metadaten), ein Prozess. Postgres wäre Betriebsaufwand und auf fly.io teurer als ein Volume.

## Entscheidung
`node:sqlite` (eingebaut, keine native Abhängigkeit), WAL. Schema nur über nummerierte SQL-Migrationen (`001`…), angewendet beim Start. `docs/erd.md` ist die Quelle der Wahrheit; ein Test vergleicht die DDL wörtlich. `audit_log` ist append-only.

## Folgen
- Schemaänderung = neue Migration **und** ERD-Update **und** Testanpassung im selben Commit.
- Parallel arbeitende Agenten bekommen Migrationsnummern vorher zugeteilt.
- Backups = Datei kopieren (T62 offen). Auf fly.io liegt die DB auf einem 1-GB-Volume in `fra`.
