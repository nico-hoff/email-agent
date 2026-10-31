# 0035 Postfächer in der App: Umsetzung von 0023

- Status: angenommen
- Datum: 2026-10-31
- Bezug: 0023 (Entscheidung), 0004 (keine Mailinhalte), 0005 (IMAP nur lesen), 0025 (Standard `off`), 0033 (Mandantenschlüssel), `docs/erd.md` (Migration 007), `docs/accounts-contract.md`

## Kontext
0023 legt fest, dass Postfächer in der App verwaltet und verschlüsselt in SQLite liegen. Offen waren Tabellenschnitt, Schlüsselverwaltung, wie der Worker-Prozess von Änderungen erfährt, der Umgang mit der Legacy-Konten-Datei und die Frage, was ein Nutzer mit „Verbindung testen“ auslösen darf.

## Entscheidung
1. **Schnitt:** `accounts` bleibt Mandantenwurzel und Metadatentabelle (Label, Farbe, Host, Port, Ordner, `enabled`, `user_id`). `mail_accounts` ist 1:1 (`account_id` PK, zusammengesetzter FK `(account_id, user_id)`) und trägt Typ (`imap|google`), TLS, Benutzername, Geheimnis (`secret_ciphertext`, `secret_nonce` 12 Byte, `secret_tag` 16 Byte), `key_id`, Testergebnis (nur ein Fehlerklassen-Code), Kontext-Text, Spam-Schwelle und `spam_seen_mode`. Konto-IDs erzeugt der Server (`a_` plus 16 Hexzeichen).
2. **Kryptografie in einem Modul** (`lib/account-secrets.ts`): AES-256-GCM, zufälliger 12-Byte-Nonce je Verschlüsselung, AAD `account_id|user_id` (ein kopierter Geheimtext funktioniert bei keinem anderen Konto oder Nutzer). Schlüssel `ACCOUNTS_ENCRYPTION_KEY` in kanonischem base64 (genau 32 Byte, strenge Prüfung). `key_id` = erste 16 Hexzeichen von SHA-256 des Schlüssels. Rotation: `ACCOUNTS_ENCRYPTION_KEY_OLD` nur zum Entschlüsseln, `npm run accounts:rekey` verschlüsselt alles in einer Transaktion neu.
3. **Fail-closed:** Fehlt der Schlüssel oder ist er (oder der alte) ungültig, startet kein Worker, `worker_status` zeigt `paused / no_encryption_key`, Anlegen und Passwortänderung antworten `503 no_encryption_key`. Ein nicht entschlüsselbares Geheimnis hält nur dieses Konto an (`secret_unreadable`).
4. **Supervisor statt Neustart:** Routenmodule teilen keinen Speicher mit `server.ts`, die DB ist der Kanal. Der Supervisor in `createService` liest alle 15 Sekunden die aktivierten Konten aller Nutzer und startet, stoppt oder startet einzelne Worker neu, wenn sich Verbindungsdaten (Host, Port, TLS, Benutzer, Passwort, Ordner) ändern. Kontext, Schwelle, Modus und Label wirken ohne Neustart. Pipeline und Postfach-Aktionen sehen die laufende Kontoliste (live, nach ID). Im synthetischen Modus gibt es weiter keine Worker.
5. **Legacy-Datei:** einmaliger Import (`npm run accounts:import`, automatisch beim Start, wenn die Datei existiert und der Schlüssel gesetzt ist) für Nutzer 1, Geheimnisse verschlüsselt, Marker `user_state (1, 'accounts_import')` in derselben Transaktion. Danach liest nichts mehr die Datei; `lib/account-modes.ts` liest `spam_seen_mode` aus der DB. Importierte Konten behalten ihren Modus (fehlend `dry_run`), neue Konten starten mit `off` (0025). Ohne Schlüssel wird nichts gelesen und kein Marker gesetzt.
6. **Server-seitige Verbindungen auf Nutzerwunsch (SSRF):** Host nur als DNS-Name oder öffentliche IP; IP-Literale in Loopback-, privaten, Link-Local-, CGNAT- und ULA-Bereichen, `localhost`, `*.local`, `*.internal` u. ä. werden abgelehnt (`host_not_allowed`). `ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` hebt das auf (Mail-Bridge auf derselben Maschine). Namen, die auf private Adressen auflösen, werden **nicht** geprüft (bekannte Grenze; DNS-Rebinding bleibt möglich). Der Test öffnet die Verbindung über den schreibgeschützten Port, führt nur LIST aus, hat 15 s Zeitlimit und ein eigenes Limit (10 je Sitzung und 10 Minuten), und speichert nur einen Code (`ok|auth_failed|tls_failed|host_unreachable|timeout|mailbox_missing|connect_failed`). Im synthetischen Modus antwortet er `synthetic_no_network`.
7. **`spam_threshold` steht jetzt im Schema.** Die frühere Regel „kein Schwellwert in der DB“ (erd.md, Entscheidung 7) entfällt; der Schema-Test verbietet weiter Inhaltsspalten (`body`, `snippet`, `excerpt`, `raw`, `attachment`, `html`, `content`).
8. **Kein neues Agenten-Tool.** ADR 0029 ist nicht berührt.

## Folgen
- `data/accounts.json` ist Legacy; Vorlage und Doku bleiben, solange Altinstallationen importieren.
- Ohne Schlüssel läuft keine Postfach-Anbindung. Prod braucht `ACCOUNTS_ENCRYPTION_KEY` vor dem ersten Start mit Konten-Datei (GitHub Environment `prod`, `docs/github-environments.md`).
- Änderungen an Verbindungsdaten wirken nach höchstens 15 Sekunden (ein Prozess, eine Maschine).
- Die Einstellungs-Oberfläche für `spam_seen_mode` (Schalter, Not-Aus, Tageslimit) folgt in R3; bis dahin wird die Spalte nur gespeichert und gelesen.
- Grenzen: kein OAuth für Google (nur App-Passwort), keine Passwort-Anzeige, keine Löschfunktion für Konten (nur Deaktivieren), Rate-Limits je Prozess.
