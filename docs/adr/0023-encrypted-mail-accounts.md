# 0023 Postfächer in der App, Zugangsdaten verschlüsselt in SQLite

- Status: angenommen
- Datum: 2026-10-31
- Bezug: 0022, 0004, `lib/accounts*.ts`, `docs/accounts.example.json`

## Kontext
Postfächer stehen heute samt Passwort in einer Konten-Datei neben der DB. Nico will sie in der App anlegen (Profil → Konten verwalten), Typen „IMAP“, „Google“, später mehr.

## Entscheidung
- Tabelle `mail_accounts` (pro `user_id`): Typ, Anzeigename, Farbe, Host/Port/TLS, Benutzername, **Geheimnis verschlüsselt** (AES-256-GCM, zufälliger Nonce, `key_id` für Rotation), Status, Einstellungen.
- Schlüssel `ACCOUNTS_ENCRYPTION_KEY` (32 Byte, base64) nur als Secret: prod auf fly, dev in `.env.local`. Nie im Repo, nie im Log, nie in der API. Fehlt der Schlüssel, startet der Worker keine Konten (fail-closed).
- Geheimnisse verlassen den Server nie; die API zeigt nur „gesetzt“ und den Zeitpunkt der letzten Prüfung.
- **Typ Google im MVP = IMAP mit App-Passwort** (`imap.gmail.com`, Voreinstellung im Formular). OAuth (Gmail-Scope, Google-Cloud-Projekt, Verifizierung) ist ein eigener späterer Meilenstein.
- „Verbindung testen“ öffnet IMAP lesend und meldet nur Erfolg/Fehlerklasse.
- Die Konten-Datei wird einmalig importiert und danach nicht mehr gelesen.

## Folgen
- Ein Leck der DB ohne Schlüssel gibt keine Passwörter preis; DB + Schlüssel zusammen schon. Snapshots enthalten nur Chiffrat.
- Schlüsselwechsel = neuer `key_id`, Umverschlüsseln per Skript.
