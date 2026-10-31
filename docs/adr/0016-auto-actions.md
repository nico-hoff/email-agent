# 0016 Auto-Aktionen: Trockenlauf-Standard, Not-Aus, Undo

- Status: angenommen
- Datum: 2026-10-30
- Bezug: Plan v5 M7a, `lib/mailbox-actions.ts`, `lib/imap-write.ts`, `docs/imap-write-contract.md`, Migration 003

## Kontext
Spam soll automatisch als gelesen markiert werden, aber ein Fehler darf keine wichtige Mail verstecken.

## Entscheidung
Pro Konto `auto_actions.spam_seen` = `off | dry_run | live`, Standard `dry_run` (protokolliert nur). Not-Aus: Datei `auto-actions.disabled` neben der DB stoppt alles sofort. Tageslimit 200 Aktionen. Jede Aktion steht in `mailbox_actions` und ist in der App rückgängig zu machen. Schutzregeln aus 0008 gehen vor.

## Folgen
- `live` schaltet nur Nico pro Konto, nach 2–3 Tagen Trockenlauf-Prüfung; danach Neustart (Executor liest den Modus beim Start).
- Quarantäne/Löschen (M7) brauchen eine neue ADR.
