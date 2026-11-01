# 0038 Quarantäne und Papierkorb: Umsetzung

- Status: angenommen
- Datum: 2026-11-01
- Bezug: setzt 0025 Teil 2 um (Plan v5 M7, Roadmap R9); erweitert 0005, 0008, 0016, 0017, 0044; `lib/imap-write.ts`, `lib/mailbox-actions.ts`, `lib/quarantine-settings.ts`, `lib/settings-api.ts`, `lib/action-undo.ts`, Migration 012, `docs/imap-write-contract.md` (Abschnitt 7)

## Kontext
ADR 0025 erlaubt vier Postfach-Aktionen. Teil 1 („gelesen“) ist mit R3 in der App. Teil 2 verschiebt Spam in den Ordner `Quarantäne`, räumt nach X Tagen in den Papierkorb des Anbieters auf und kennt einen „YOLO“-Modus. Nie endgültig löschen, nie senden.

## Entscheidung
**Schreibport.** `lib/imap-write.ts` bekommt eine dritte Methode, `moveMessage({ folder, uidValidity, uid, target })` mit `target` ∈ `quarantine | trash | inbox`. Sie nutzt ausschließlich ein **natives IMAP MOVE** (`messageMove`). Context7 und die installierten Quellen (`imapflow` 2.9.1, `commands/move.js`) zeigen: Fehlt dem Server die Fähigkeit `MOVE`, **emuliert imapflow still mit COPY + `\Deleted` + EXPUNGE**. Das ist verboten. Der Port prüft deshalb nach dem Login `capabilities.has("MOVE")` und bricht sonst mit `move_unsupported` ab, bevor er Ordner liest, anlegt oder sperrt. Es gibt keinen Rückfall.
- Ablauf je Verschiebung: eigene kurzlebige Verbindung, Fähigkeit prüfen, Zielordner bestimmen, schreibbare Sperre auf dem Quellordner, UIDVALIDITY gegen den gespeicherten Wert prüfen, UID noch vorhanden?, `MOVE`, Rücklesen (UID im Quellordner weg), bei `COPYUID` zusätzlich Zielordner schreibgeschützt prüfen (UIDVALIDITY und neue UID dort vorhanden). Ohne `COPYUID` (kein UIDPLUS) gilt die Verschiebung nach dem Quellcheck als erledigt, der neue Ort bleibt unbekannt.
- **Zielordner.** `Quarantäne`: aus `LIST` unter dem Namensraum-Präfix des Servers gesucht, sonst per `mailboxCreate` angelegt (imapflow setzt Präfix, Trenner und modifiziertes UTF-7 selbst, legt an und abonniert). Anlegen passiert nur im Schreibpfad dieser Methode für `target: quarantine`; der Lesepfad (`lib/imap.ts`) kennt `mailboxCreate` nicht. Papierkorb: `\Trash` aus `LIST` (Special-Use der Erweiterung vor dem Namens-Hinweis von imapflow), sonst feste Namensliste (Trash, Papierkorb, Deleted Items, …); nichts gefunden: `trash_not_found`, **es wird nie ein Papierkorb angelegt**. `inbox` ist der Ordner des Kontos (`accounts.mailbox`).
- Neue Fehlercodes: `move_unsupported`, `move_rejected`, `move_unverified`, `trash_not_found`, `folder_create_failed`.

**Regeln (`lib/mailbox-rules.ts`).** `decideQuarantine`: Schutz zuerst (`security_auth`, `transactional`, Positivliste), dann Jev-`is_spam` oder Negativliste. Nur Mails, deren aktiver Ort der Posteingang des Kontos ist; der Spam-Ordner des Anbieters allein ist kein Grund. Bereits gelesene Mails werden ebenfalls verschoben. Fail-closed wie „gelesen“. Importierte Mails (`origin = 'import'`, ADR 0043) werden nie angefasst.

**Protokoll.** `mailbox_actions` (Migration 003, keine Änderung): Regel `quarantine` (`move_quarantine`), `purge` (`move_trash`, auch bei YOLO und beim Aufräumen), `undo` (`move_inbox`). Je Mail höchstens eine Zeile je Regel (Unique-Index); fehlgeschlagene Zeilen werden nicht wiederholt. Ein erfolgreicher Move macht den alten Ort in `email_locations` inaktiv und legt den neuen an (Ordner, UIDVALIDITY, UID aus `COPYUID`), dazu `audit_log` `folder_changed` und `mailbox_action` (nur Codes). Das Tageslimit (200 Live-Aktionen je Konto in 24 Stunden) zählt Verschiebungen mit; Undo-Zeilen zählen nicht. Not-Aus-Datei und Not-Aus des Nutzers (0044) werden vor jeder Aktion gelesen, auch beim Aufräumen und Undo.

**Einstellungen (Migration 012).** Drei Spalten an `mail_accounts` (nicht eine neue Tabelle): `quarantine_mode` (`off | dry_run | live`, Standard `off`), `quarantine_days` (1 bis 90, Standard 14), `quarantine_yolo` (0/1, Standard 0). Grund: Sie gehören 1:1 zum Konto, wie `spam_seen_mode`; Mandantenschutz und Löschen laufen über dieselbe Zeile. Der Executor liest sie bei jeder Aktion direkt aus der Datenbank (keine Verzögerung durch den Supervisor-Takt). Nur der angemeldete Nutzer ändert sie über `POST /api/settings/quarantine`; `live` und YOLO verlangen `confirm: true`; YOLO setzt einen Modus ≠ `off` voraus, und `off` setzt YOLO zurück. Agenten haben keinen Zugriff.

**YOLO.** Spam wird sofort (`purge` / `move_trash`) aus dem Posteingang in den Papierkorb verschoben, ohne Quarantäne. Warndialog in der App; im Trockenlauf plant er `move_trash`.

**Aufräumen.** Ein Job im Server-Prozess (alle 30 Minuten und einmal nach dem Start) verschiebt Mails, deren Quarantäne-Aktion (`done`, `live`) älter ist als `quarantine_days` und die noch im Ordner `Quarantäne` liegen, in den Papierkorb. Schutz wird erneut geprüft (eine inzwischen angelegte Positivliste hält die Mail zurück). Im Trockenlauf werden nur `purge`-Zeilen geplant.

**Undo.** `POST /api/actions/:id/undo` für Aktionen der Regeln `quarantine` und `purge`: geplant = Plan verwerfen (nur App); erledigt = zurück in den Posteingang (`move_inbox`, Regel `undo`), danach gelten die Move-Zeilen der Mail als `undone`, der Unique-Index verhindert ein erneutes Verschieben. Fremde Aktions-IDs sind `404`.

## Folgen
- H1 bleibt in der Fassung von 0025: Schreiben nur über den Port, nur `\Seen`, Move Posteingang → Quarantäne → Papierkorb des Anbieters und zurück in den Posteingang. Kein `\Deleted`, kein EXPUNGE, kein COPY, kein Senden, keine Entwürfe.
- Server ohne `MOVE` können Quarantäne und Papierkorb nicht nutzen (Aktion `failed`, `move_unsupported`).
- Ohne `UIDPLUS` ist der neue Ort unbekannt: kein Aufräumen und kein Undo für diese Mail.
- Zwischen `MOVE` und Rücklesen gibt es kein Rollback; ein Fehler dazwischen wird als `failed` protokolliert, die Mail liegt dann dort, wo der Server sie hingelegt hat.
- Der Posteingang-Sync sieht eine zurückverschobene Mail als neue UID (bekannte Mail, neuer Ort); sie wird nicht neu klassifiziert (Unique-Schlüssel Mail, Fragenset, Modell), außer der Nutzer hat inzwischen das Klassifikationsmodell gewechselt.
