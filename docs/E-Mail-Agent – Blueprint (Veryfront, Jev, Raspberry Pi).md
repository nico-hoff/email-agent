# E-Mail-Agent – Blueprint (Veryfront, Jev, Raspberry Pi)

Stand: 26.10.2026 · Zielgruppe: Coding-Agent. Auftrag: Implementiere diesen Plan Schritt für Schritt, committe pro Phase, und stoppe an den markierten Freigabepunkten.

## 1. Ziel und Nicht-Ziele

Ziel: Ein proaktiver E-Mail-Agent für drei Postfach-Gruppen. Ein schnelles System-One-Modell (Jev) sortiert eingehende Mails vor, damit das LLM Spam nie sieht. Echte Mails werden vom Agenten zusammengefasst, es werden Antwortentwürfe erstellt, und Nico wird per Telegram benachrichtigt.

Nicht-Ziele in v1: Der Agent sendet nie selbst Mails. Er hat keine Lösch-Rechte außer dem automatischen Verschieben in Quarantäne. Kein lokaler LLM-Fallback. Keine Speicherung von Mail-Inhalten in der Datenbank. Keine Anbindung an das Second Brain (nur vorbereiten).

## 2. Entscheidungen (fix)

- Framework: Veryfront (TypeScript, React) für Agenten, Tools, Tasks, Workflows, Evals und die Web-UI.
- Architektur: Ein einziger Prozess enthält Agent und Tools. Kein separater MCP-Server. Secrets kommen ausschließlich über Umgebungsvariablen.
- LLM-Zugriff: OpenRouter. Modelle: GPT-6 Luna für den Agenten, jev-latest für die Vorklassifikation.
- Mail-Anbindung: ImapFlow (IMAP mit IDLE) direkt als Bibliothek, kein Himalaya-Wrapper.
- Datenbank: SQLite (eine Datei) mit aktivierten Foreign Keys, Metadaten-only.
- Channel: Telegram für Benachrichtigungen. Web-UI in Veryfront als Übersicht.
- Deployment: Raspberry Pi 4 mit 8 GB, Build in GitHub Actions, Deploy per SSH, Betrieb als systemd-Dienst.
- Ausfallverhalten: Fällt Jev oder OpenRouter aus, bleiben Mails unverändert liegen und werden beim nächsten Lauf nachgeholt.

## 3. Konten

Drei Konto-Gruppen, jeweils nur Konfiguration (Host, Port, Auth-Art, Quarantäne-Ordnername, Schwellwerte): Gmail (App-Passwort zum Start, OAuth später möglich), zwei web.de-Konten (IMAP in den Einstellungen aktivieren, ggf. App-Passwort), eine eigene Domain (Host vom Hoster, meist Benutzername und Passwort).

Konto-spezifische Schwellwerte sind Pflicht, weil sich die Spam-Lage stark unterscheidet. Die Custom-Domain enthält fast nur wichtige Mails: Dort ist schon ein moderater Spam-Verdacht ein Alarmsignal und führt nie zu automatischem Verschieben, sondern zu einer Meldung.

## 4. Klassifikations-Pipeline

Ablauf pro neuer Mail: IDLE-Event, Metadaten und Header abrufen, Eintrag in der Datenbank anlegen, Jev befragen, Entscheidung speichern, dann je nach Ergebnis handeln.

Jev-Fragen (System-One-Protokoll, Fragearten Choice, Score, Null): Eine Choice-Frage mit den Optionen Spam, Newsletter, Transaktional, Persönlich oder geschäftlich, Unklar. Eine Score-Frage für Dringlichkeit. Eine Null-Frage zur Abdeckung, ob die Mail überhaupt beurteilbar ist. Als State gehen nur die benötigten Felder hinein (Absender, Betreff, gekürzter Textauszug, Header-Signale wie SPF und DKIM), nicht die ganze Mail, wegen des Token-Budgets.

Aktionen: Spam-Wahrscheinlichkeit von mindestens 95 Prozent führt zum Verschieben in einen Quarantäne-Ordner, der nach 30 Tagen automatisch geleert wird. Das ist der Vorschlag anstelle von hartem Löschen, die endgültige Entscheidung liegt bei Nico. Alles dazwischen bleibt im Posteingang und wird markiert. Nur Mails, die als echt eingestuft sind, gehen an den Agenten.

## 5. Agent und Tools

Der Agent sieht ausschließlich Mails, die Jev als nicht spam eingestuft hat. Mail-Texte werden im Prompt klar als nicht vertrauenswürdige Daten gekennzeichnet.

Tools, eng geschnitten: Ungelesene und offene Mails eines Kontos auflisten, eine Mail lesen, Mail zusammenfassen, Entwurf im Entwürfe-Ordner anlegen, Telegram-Nachricht an Nico senden, Mail als gelesen oder wichtig markieren. Es gibt kein Tool zum Senden und kein Tool zum Löschen. Das Verschieben in Quarantäne macht allein die Pipeline-Logik, nicht der Agent.

Beispiel-Ablauf proaktiv: Neue echte Mail, der Agent fasst sie zusammen, legt bei Bedarf einen Entwurf an und schreibt Nico auf Telegram, warum die Mail relevant ist und dass ein Entwurf bereitliegt. Beispiel reaktiv: Nico fragt auf Telegram, ob offene Mails da sind, der Agent listet und fasst zusammen.

## 6. Datenmodell (SQLite)

Tabelle accounts: id als Primärschlüssel, Bezeichnung, Host, Port, Auth-Art, Schwellwerte, aktiv. Secrets stehen nie in der Datenbank.

Tabelle emails: id als Primärschlüssel, account\_id als Fremdschlüssel auf accounts, Message-ID, IMAP-UID, Absender, Betreff, Empfangsdatum, Ordner, Status. Eindeutigkeit über Konto und Message-ID. Keine Mail-Inhalte.

Tabelle classifications: id, email\_id als Fremdschlüssel, Modell und Version, Fragetyp, Ergebnis, Wahrscheinlichkeiten, Konfidenz, angewendeter Schwellwert, Zeitstempel.

Tabelle audit\_log, nur anhängen und nie ändern: id, Zeitstempel, Akteur (Pipeline, Agent, Nico), Aktion (verschoben, Entwurf erstellt, Telegram gesendet, markiert), email\_id als optionaler Fremdschlüssel, Details als JSON, Trace-ID.

Tabelle drafts: id, email\_id, Entwurf-UID im Entwürfe-Ordner, Status. Indizes auf account\_id, Empfangsdatum und Trace-ID. Migrationen als nummerierte SQL-Dateien, Foreign Keys per Pragma aktivieren, WAL-Modus einschalten.

## 7. Evals

Eval-Set aus Nicos echten Mails, vorher von ihm gelabelt, mit einem eigenen Anteil an Prompt-Injection-Beispielen. Gemessen werden die Fehlerrate bei Spam (False Positives sind teurer als False Negatives), die Trefferquote bei wichtigen Mails und die Robustheit gegen Injection im Agenten. Jede Entscheidung wird mit Wahrscheinlichkeit geloggt, damit die Schwellwerte nach den ersten Wochen anhand echter Daten nachgeschärft werden können.

## 8. Deployment

GitHub Actions: Installieren, Typprüfung, Tests, Build, dann Übertragung des Build-Ergebnisses per SSH auf den Pi und Neustart des systemd-Dienstes. Der Pi baut nicht selbst. Für den SSH-Zugriff aus der Pipeline ist Tailscale vorgesehen, falls der Pi nicht öffentlich erreichbar ist. Der Dienst startet nach Neustart und Absturz automatisch. Die SQLite-Datei bekommt ein tägliches Backup.

## 9. Umgebungsvariablen

OpenRouter-Schlüssel, Telegram-Bot-Token und Chat-ID, pro Konto Zugangsdaten, Pfad zur SQLite-Datei. Nichts davon wird eingecheckt.

## 10. Phasen und Freigabepunkte

Phase 1: Projektgerüst mit Veryfront, SQLite-Schema mit Migrationen, Konfiguration der Konten. Phase 2: ImapFlow-Anbindung mit IDLE für ein einziges Testkonto, Metadaten in die Datenbank. Phase 3: Jev-Anbindung über OpenRouter, Klassifikation im reinen Beobachtungsmodus, also nur loggen, nichts verschieben. Freigabepunkt: Nico prüft die geloggten Entscheidungen. Phase 4: Quarantäne-Logik mit Schwellwerten pro Konto. Phase 5: Agent mit den eng geschnittenen Tools, Entwürfe und Telegram. Phase 6: Evals und Injection-Tests. Phase 7: Web-UI-Übersicht, CI/CD und Deployment auf den Pi. Phase 8 (später): Anbindung an das Second Brain per MCP, indem relevante Mails als Episoden hinzugefügt werden.

## 11. Offene Punkte

Automatisches Löschen oder Quarantäne, endgültig zu entscheiden. Gmail per App-Passwort oder OAuth. Genaue Jev-Preise und Zugangsart über OpenRouter. Ob später doch Mail-Inhalte gespeichert werden sollen.
