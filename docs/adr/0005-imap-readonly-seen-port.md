# 0005 IMAP lesend, eigener Schreibport nur für `\Seen`

- Status: angenommen
- Datum: 2026-10-20, erweitert 2026-10-29 (Plan v5 M7a)
- Bezug: `docs/imap-write-contract.md`, `lib/imap-write.ts`, `lib/imap.ts`, `workers/imap-worker.ts`, ImapFlow

## Kontext
Ursprünglich galt: keine Mailbox-Schreibaktionen. Nico will Spam auch serverseitig als gelesen sehen.

## Entscheidung
Der Lesepfad öffnet Postfächer immer mit `readOnly: true`. Schreiben geht **nur** über `lib/imap-write.ts`: eigene Verbindung, nur `addSeen`/`removeSeen`, UIDVALIDITY-Prüfung, Rücklesen des Flags. Verschieben, Löschen, Entwürfe, Senden bleiben verboten, bis eine neue ADR (M7 Quarantäne) sie erlaubt.

## Folgen
- Jede Schreibaktion landet in `mailbox_actions` und ist rückgängig machbar (0016).
- Tests (`tests/imap.test.ts`, `tests/imap-write.test.ts`) prüfen `readOnly` im Lesepfad und die Grenzen des Schreibports.
