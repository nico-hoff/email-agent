# 0022 Nutzerkonten (IAM), mehrnutzerfähig, Registrierung per Einladung

- Status: angenommen
- Datum: 2026-10-31
- Bezug: ersetzt 0020; ändert 0011 (Zugangsmodi), 0003 (Schema), `docs/erd.md`

## Kontext
Nico will sich in der App registrieren und dort seine Postfächer und Einstellungen verwalten, statt JSON-Dateien und eines globalen `APP_PASSWORD`. Langfristig ist go2market möglich.

## Entscheidung
- Tabelle `users` (E-Mail, scrypt-Passworthash, Rolle `admin|user`, Status), Sitzungen pro Nutzer (signiertes Cookie mit `user_id`, serverseitig widerrufbar).
- **Mehrnutzerfähiges Datenmodell:** jede nutzerbezogene Tabelle bekommt `user_id`; jede Abfrage filtert danach (zentral in `lib/`, Tests prüfen die Trennung).
- **Registrierung im MVP nur per Einladung** (Einladungscode vom Admin). Erster Admin per CLI (`npm run user:create`) bzw. im Dev automatisch als Testnutzer.
- Offene Registrierung erst nach dem go2market-Gate (DSGVO, AGB, Datenschutzerklärung, Löschkonzept).
- `APP_PASSWORD` und Tailnet-Modus bleiben, bis die Migration fertig ist, und werden dann entfernt bzw. nur noch für den Bootstrap genutzt (eigene ADR beim Entfernen).
- Login-Schutz bleibt: Rate-Limit, konstante Laufzeit, `Secure`-Cookie, CSRF (0012).

## Folgen
- Migration 006+ mit `user_id`, ERD-Update, Datenübernahme der heutigen Daten auf Nicos Nutzer.
- Agenten (Briefing, Entwurf) und Worker laufen pro Nutzer.
