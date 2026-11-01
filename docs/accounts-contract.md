# Vertrag: Postfächer in der App (R2)

Quelle: ADR 0023 (Entscheidung) und 0035 (Umsetzung), Schema in `docs/erd.md` (Migration 007).

## Datenhaltung
- `accounts` (Mandantenwurzel, Metadaten) und `mail_accounts` (1:1, Zugangsdaten verschlüsselt). Konten ohne Zeile in `mail_accounts` (Demo-Daten, Konten vor dem Import) werden angezeigt, aber nie von einem Worker gestartet und lassen sich nicht ändern (`not_managed`).
- Passwort: AES-256-GCM, Nonce 12 Byte zufällig, AAD `account_id|user_id`, Spalten `secret_ciphertext`, `secret_nonce`, `secret_tag`, `key_id` (erste 16 Hexzeichen von SHA-256 des Schlüssels).
- Schlüssel: `ACCOUNTS_ENCRYPTION_KEY`, genau 32 Byte in kanonischem base64 (`openssl rand -base64 32`). `ACCOUNTS_ENCRYPTION_KEY_OLD` entschlüsselt nur. Ungültig oder fehlend = fail-closed.
- Geheimnisse verlassen den Server nie: API und UI zeigen `secret_set` und `secret_set_at`. Nichts davon in Logs, Audit-Zeilen oder Fehlermeldungen (Audit: nur `account_created|updated|enabled|disabled` mit Typ bzw. `secret_changed`).

## Schlüsselverwaltung
| Situation | Verhalten |
|---|---|
| Schlüssel fehlt/ungültig | Kein Worker startet. `worker_status`: `paused`, `error_code = no_encryption_key`, in der UI sichtbar. Anlegen/Passwort ändern: `503 no_encryption_key`. Ändern ohne neues Passwort geht. |
| Geheimnis nicht entschlüsselbar (anderer Schlüssel, manipuliert, in anderes Konto kopiert) | Nur dieses Konto: `paused / secret_unreadable`; Test: `409 secret_unreadable`. Passwort neu eintragen behebt es. |
| Rotation | Neuen Schlüssel erzeugen, `ACCOUNTS_ENCRYPTION_KEY=<neu>` und `ACCOUNTS_ENCRYPTION_KEY_OLD=<alt>` setzen, `npm run accounts:rekey` (eine Transaktion, alles oder nichts), danach `_OLD` entfernen und neu starten. |

## Worker und Supervisor
Der Supervisor (`lib/account-supervisor.ts`) läuft im Server-Prozess und liest alle 5 s die DB: aktivierte, entschlüsselbare Konten aller Nutzer → ein Worker je Konto. Neu/aktiviert: Start. Deaktiviert/entfernt: Stopp, Status `disabled`. Geänderte Verbindungsdaten (Host, Port, TLS, Benutzer, Passwort, Ordner): Neustart nur dieses Workers. Label, Farbe, Kontext, Schwelle, Modus wirken ohne Neustart. Synthetischer Modus: keine Worker.

## Erst-Import (ADR 0043)
Ein neues Konto bekommt in der Anlegen-Transaktion die Zeile `account_sync` (`queued`); ältere Konten beim ersten Workerstart. Der Worker liest nach dem Baseline-Checkpoint genau einmal die neuesten bis zu 50 Mails (Obergrenze 200) der letzten 14 Tage aus dem Posteingang mit UIDs `<=` Checkpoint (lesend, Inhalt nur im Speicher), klassifiziert sie über die normale Pipeline und meldet Zähler und Phase in `account_sync`. Importierte Mails (`emails.origin = 'import'`) lösen keine automatische Postfach-Aktion aus und zählen nicht als „neu seit dem letzten Öffnen“. Antworten und Tabelle enthalten nur Zähler, Phasen und Codes (`imap_auth`, `imap_error`, `no_range`, `classify_timeout`).

## Import der Legacy-Datei
`npm run accounts:import` oder automatisch beim Start (Datei vorhanden **und** Schlüssel gesetzt, Marker fehlt). Konten gehören Nutzer 1, Geheimnisse werden verschlüsselt, `spam_seen_mode` bleibt (fehlend `dry_run`), Typ `google` bei Host `imap.gmail.com`. Marker `user_state (1, 'accounts_import')` in derselben Transaktion; danach wird die Datei nie wieder geöffnet. Ausgaben nennen nur Anzahl und Codes. Ohne Schlüssel: nichts gelesen, kein Marker (Hinweis im Log). Die Datei kann nach erfolgreichem Import gelöscht werden.

## API (Sitzung; Änderungen mit CSRF und Rate-Limit; fremde IDs 404)
| Route | Zweck |
|---|---|
| `GET /api/accounts` | Konten des Nutzers (ohne Geheimnis), `encryption.ready`, `synthetic` |
| `POST /api/accounts` | anlegen; Body: `type` (`imap|google`), `label` (≤ 40), `color?`, `host?`, `port?`, `tls?`, `username`, `password`, `mailbox?`, `spam_mailbox?`, `context?` (≤ 1000). ID erzeugt der Server. Neue Konten: `spam_seen_mode = off`. `201` |
| `POST /api/accounts/:id` | ändern; `password` leer/fehlend = behalten; Typ unveränderlich |
| `POST /api/accounts/:id/disable`, `/enable` | Betrieb ein/aus |
| `POST /api/accounts/:id/test` | Verbindungstest (nur LIST, schreibgeschützter Port, 15 s, 10 je 10 min). Antwort `{ ok, code }` mit `ok|auth_failed|tls_failed|host_unreachable|timeout|mailbox_missing|connect_failed`; synthetisch `synthetic_no_network` |

| `GET /api/accounts/:id/sync` | Erst-Import (ADR 0043): `{ sync: { phase, total, fetched, classified, failed, error_code, runs, started_at, updated_at, finished_at, feed } }`; `feed` = bis zu 10 zuletzt bewertete importierte Mails als Listenobjekte (wie `/api/emails`). Konto ohne Import: `{ sync: null }` |
| `POST /api/accounts/:id/sync/restart` | Import erneut starten; nur aus `done`/`failed` (sonst `409 not_restartable`), gleiches Rate-Limit wie der Verbindungstest. Antwort `{ ok, phase: "queued" }` |

Fehlercodes: `invalid_body` (400, mit Feldnamen), `invalid_host`, `host_not_allowed`, `invalid_secret` (400), `not_found` (404), `not_managed`, `secret_unreadable` (409), `no_encryption_key` (503), `rate_limited` (429).

Formular: sichtbar sind E-Mail-Adresse, Passwort und IMAP-Server; der Server wird aus der Domain vorgeschlagen (`lib/mail-provider-hints.ts`, feste Liste, kein Netz). Benutzername und Bezeichnung folgen der Adresse, solange sie nicht von Hand geändert wurden; alles weitere liegt unter „Erweitert“. Der Typ ergibt sich aus dem Server (`imap.gmail.com` = `google`).

Spam-Ordner: Hat ein Konto keinen, erkennt `POST /api/accounts/:id/test` ihn über das Special-Use-Merkmal `\\Junk` aus LIST (ImapFlow `specialUse`), sonst über gängige Namen (`Junk`, `Spam`, `Junk E-Mail`, …), und speichert ihn (Antwort enthält dann `spam_mailbox`). Ein eingetragener Ordner wird nie überschrieben.

Typ `google`: Host `imap.gmail.com`, Port 993, TLS an, Ordner `INBOX` und `[Gmail]/Spam` (Ordner änderbar); Authentifizierung nur per App-Passwort (Leerzeichen werden entfernt).

## Host-Regeln (SSRF)
Erlaubt: DNS-Namen und öffentliche IP-Literale. Abgelehnt: URLs, Ports, Leerzeichen, Kurzformen (`127.1`, `0x7f…`), Einzelnamen, `localhost`, `*.local|internal|lan|home|corp|intranet|localhost`, IP-Literale in `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `192.0.0/24`, `198.18/15`, `224+`, IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-gemappt. `ACCOUNTS_ALLOW_PRIVATE_HOSTS=1` hebt die Bereichsregel auf. **Grenze:** DNS-Namen, die auf private Adressen zeigen, werden nicht aufgelöst/geprüft.

## Datenschutz
Es werden keine Mailinhalte berührt. Der Test wählt keinen Ordner aus und lädt nichts. `context` ist ein vom Nutzer geschriebener Kurztext (wie in der Legacy-Datei) und geht als Hinweis in die Bewertung; er soll keine Mailinhalte enthalten.

## Einstellungen im Profil (R3, ADR 0025 Teil 1, 0041, 0044)

Alle `POST`-Routen: Sitzung, Rate-Limit, CSRF (`guardMutation`); Nutzerbezug aus der Sitzung; ein fremdes Konto ist `404`. Antworten enthalten nur Schalter, Zähler, Ids und Codes.

| Route | Zweck |
|---|---|
| `GET /api/settings` | `stop` (`user_stopped_at`, `global_active`, `can_toggle_global`), `daily_limit`, `accounts[]` (`id`, `label`, `color`, `enabled`, `managed`, `spam_seen_mode`, `actions_24h`), `classifier` (`{permitted:false}` oder `{permitted:true, model, models[]}` mit `selectable`, `relative_cost`, `usd_per_1000`), nur Admins: `members[]` |
| `POST /api/settings/spam-seen` | `{ account_id, mode: off|dry_run|live, confirm? }`. `live` ohne `confirm: true` ist `400 confirmation_required`; Konto ohne Zugangsdaten `409 not_managed` |
| `POST /api/settings/quarantine` | R9, ADR 0038: `{ account_id, mode?: off|dry_run|live, days?: 1..90, yolo?: boolean, confirm? }` (mindestens ein Feld). `live` und `yolo: true` ohne `confirm: true` sind `400 confirmation_required`; YOLO bei Modus `off` `409 quarantine_off`; `off` setzt YOLO zurück; Konto ohne Zugangsdaten `409 not_managed`; fremdes Konto `404`. `GET /api/settings` liefert je Konto `quarantine: { mode, days, yolo }` (`null` ohne Zugangsdaten) |
| `POST /api/actions/:id/undo` | R9: nimmt eine Quarantäne- oder Papierkorb-Aktion zurück (Plan verwerfen oder Mail zurück in den Posteingang). `404` bei fremder oder unbekannter Aktion, `409` (`kill_switch`, `user_stop`, `not_undoable`, `no_location`), `503` (`account_unavailable`), `502` (Code des Schreibports) |
| `POST /api/settings/stop` | `{ scope: user|global, stopped, confirm? }`. `global` nur Admin (`403`), mit `confirm: true`; legt die Datei `auto-actions.disabled` an oder entfernt sie |
| `POST /api/settings/classifier` | `{ model }`; ohne Berechtigung `403`, unbekannt `400 invalid_model`, nicht kalibriert `409 not_calibrated` |
| `POST /api/settings/permissions` | Admin: `{ user_id, classifier_choice }`; unbekannter Nutzer `404` |

Neue Konten starten mit `spam_seen_mode = off`. Der Modus wirkt im Server nach dem nächsten Supervisor-Takt (bis 15 s).
