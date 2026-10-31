# 0025 Postfach-Aktionen in den Profil-Einstellungen: gelesen, Quarantäne, Papierkorb

- Status: angenommen
- Datum: 2026-10-31
- Bezug: lockert H1 (`docs/IMPLEMENTATION_PLAN.md`) und erweitert 0005, 0016, 0017; Plan v5 M7

## Kontext
Nico will Auto-Aktionen selbst in der App scharf schalten und Spam nicht nur als gelesen markieren, sondern in Quarantäne verschieben und nach einer Frist (oder sofort, „YOLO“) entfernen. Alle Aktionen sollen auf dem IMAP-Server wirken.

## Entscheidung
Pro Postfach in den Profil-Einstellungen, **standardmäßig aus**, nur der Nutzer selbst schaltet um (Agenten nie):
1. **Spam als gelesen** (`\Seen` auf dem Server): `aus | Trockenlauf | an`.
2. **Quarantäne:** Spam per IMAP `MOVE` in den Ordner `Quarantäne` (wird bei Bedarf angelegt).
3. **Aufräumen:** nach X Tagen (Standard 14, einstellbar) aus der Quarantäne in den **Papierkorb des Anbieters** verschieben.
4. **YOLO:** Spam sofort in den Papierkorb, mit deutlicher Warnung beim Einschalten.

Grenzen: nie `EXPUNGE`/endgültiges Löschen; alles nur über den Schreibport (`lib/imap-write.ts`, erweitert um `move`), UIDVALIDITY-Prüfung, Rücklesen, `mailbox_actions`-Protokoll, Undo (zurückverschieben), Tageslimit, Not-Aus-Datei. Schutzregeln aus 0008 (`security_auth`, `transactional`, Allowlist) gelten immer vor jeder Aktion.

## Folgen
- H1 lautet künftig: Mailbox-Schreiben nur über den Schreibport und nur für diese vier Aktionen; Senden, Entwürfe, Flags außer `\Seen` und endgültiges Löschen bleiben verboten.
- Neue Werte in `mailbox_actions` (Migration), Contract `docs/imap-write-contract.md` erweitern.
