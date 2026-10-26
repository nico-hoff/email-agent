# Handover: Ergänzungen zum 80/20-E-Mail-Agenten

**Status:** Dieses Dokument hält die zuletzt besprochenen Punkte fest, die im aktuellen Plan `.hermes/plans/2026-10-26_194916-email-agent-80-20.md` noch nicht sauber eingearbeitet sind. Vor Implementierung mit dem Plan zusammenführen; bei widersprüchlicher oder nicht belegter SDK-Semantik zuerst Context7 und installierte Typen prüfen. Es wurden hier keine Projektcodeänderungen vorgenommen.

## Vor dem Start: externe Voraussetzung und Env-Laden

- Vor Phase 0 muss Nico `.env.local` lokal mit `OPENROUTER_API_KEY`, `ACCOUNTS_FILE` und `DATABASE_PATH` einrichten und verfügbares OpenRouter-Guthaben für `typesafe/jev-1.13` bestätigen. Key niemals ausgeben oder committen. Fehlt Key/Guthaben, vor Beginn stoppen, nicht mitten in Task 9.
- Node lädt `.env.local` nicht automatisch. Lokale Scripts, Probe, Sample und Eval müssen ausdrücklich mit `node --env-file=.env.local ...` laufen. Für einen Containerstart ohne Datei nur die vorhandene Prozessumgebung verwenden bzw. optional `--env-file-if-exists`; nicht voraussetzen, dass Veryfront die Datei lädt.
- `BIND_ADDRESS` bleibt ein operativer Sonderfall neben den drei fachlichen Env-Variablen: Default `127.0.0.1`, in Compose `0.0.0.0`.

## Jev-Proben: keine Task-9/10-Abhängigkeitsschleife

1. Zuerst eine **Minimalprobe** nur mit je einem dokumentationskonformen Noul, Choice und Score schreiben. Die Frageformen müssen gegen Context7 und die installierten SDK-Typen geprüft sein; Task 9 darf nicht auf den späteren vollen Fragensatz warten.
2. Den einmaligen Probe-Runner als `tools/jev-contract-probe.ts` anlegen, mit `.env.local` ausführen, nur eine synthetische Mail senden und danach löschen. Das erste echte Fixture wird `tests/fixtures/jev-minimal-response.json`.
3. Danach das vollständige `email-classification-v1`-Fragenset bauen. Anschließend einen **zweiten** synthetischen API-Aufruf für das volle Set machen und dessen Antwort in `tests/fixtures/jev-email-v1-response.json` sichern.
4. Tests gegen beide realen, synthetischen Fixtures schreiben. Antwortfelder, Wahrscheinlichkeiten, Scorebereiche und Noul-Semantik nicht ergänzen, bevor Context7, SDK-Typen und Fixture sie bestätigen. `typesafe/jev-1.13` pinnen und das tatsächlich zurückgelieferte Modell je Lauf protokollieren.

## IMAP-Identität und Folder-Moves

- IMAP UID/UIDVALIDITY sind **pro Mailbox/Ordner** gültig, nicht nur pro Konto. `mailbox_state` benötigt Primärschlüssel `(account_id, mailbox)`.
- Eindeutigkeit für eine Folder-Location ist `(account_id, folder, uid_validity, uid)`. Ein Modell mit logischer `emails`-Zeile plus `email_locations`-Tabelle bildet Folder-spezifische UIDs am saubersten ab.
- Bei gleicher Message-ID, die nachträglich von INBOX in den Spam-Ordner verschoben wird, per `(account_id, message_id)` upserten, neue Location hinzufügen und ein append-only `folder_changed`-Ereignis speichern. Nicht durch eine globale UID-/Message-ID-Unique-Constraint abstürzen. Fehlt die Message-ID, bleibt die Location über den Folder-UID-Schlüssel eindeutig.
- Klassifikations-Idempotenz pro logischer Mail und `question_set_version` halten; ein bereits klassifizierter UID wird übersprungen. Bei neuer Frageversion Body erneut über die gespeicherte Folder-/UID-Location laden, nie aus der DB.

## IDLE-Liveness, Polling und Status

- IDLE kann ohne Fehler still sterben (NAT-/Provider-Timeout). Ein Event-Listener allein reicht nicht.
- Mit einem ImapFlow-Client je Account IDLE auf der primären Inbox nutzen und alle beobachteten Ordner — insbesondere den Spam-Ordner — zusätzlich alle paar Minuten per gespeicherten UID-Checkpoint pollen. IDLE-Events lösen sofortige, serialisierte Syncs aus; Polling ist der Fallback.
- Watchdog überwacht erfolgreiche Protokoll-/Poll-Aktivität und erzwingt bei veralteter Verbindung einen Reconnect nur für den betroffenen Account. **Kein neues Mail-Event allein ist kein Fehler:** leere/ruhige Postfächer dürfen nicht endlos reconnecten.
- `/api/health` bleibt Prozess-Liveness. Neue GET-only-Route `/api/status` gibt je Account `connected`, `backoff`, `paused`, `last_event_at`, `last_poll_at` und einen nicht-sensiblen Fehlercode zurück. Keine Hostnamen, User, Subjects, Bodies oder Secrets.
- Docker-Healthcheck darf die Status-Route auf HTTP-Liveness prüfen; ein legitimer `paused`-/`backoff`-Worker darf nicht eine Container-Restart-Schleife auslösen. Workerzustand steht im JSON.

## Retry-Ausführung und gelöschte Quelldaten

- Persistierte `retry_wait`-Zeilen brauchen zwei Weckwege: fällige Retries beim Prozessstart laden und einen laufenden Timer, der `next_attempt_at <= now` abholt.
- Wenn die ursprüngliche Folder/UID-Quelle nicht mehr existiert und keine aktive Location derselben logischen Mail verfügbar ist, mit `status=failed`, `failure_code=source_gone` beenden; nicht endlos retryn.
- OpenRouter-Statuspolicy aus dem Userfeedback: 429/5xx/524/529 wiederholbar; 400/403/413 dauerhaft fehlgeschlagen; 401/402 Account-Worker pausieren. SDK-Retries und eigener Backoff dürfen nie gleichzeitig aktiv sein. Exakte RetryConfig anhand Context7/SDK-Typen festlegen.

## Sample: Kosten, Zustimmung und Idempotenz

- Bis zu 200 letzte Mails je INBOX und konfiguriertem web.de-Spam-Ordner bedeuten bis zu **400 echte Nachrichten** an einen Drittanbieter. Sample niemals still starten.
- Erster Lauf ist reine Vorschau: ausgewählte Anzahl je Ordner ausgeben, keine Jev-Aufrufe. Ausführung verlangt `--confirm <exakte-vorschau-anzahl>`; bei abweichender Auswahl abbrechen. Hartes Limit 400 gesamt, keine Überschreibung.
- Gleiches Konto/Mail/Question-Set überspringen; mit `--question-set <version>` darf derselbe ausgewählte Bestand bewusst neu evaluiert werden. Re-Run holt den Body neu per aktiver Folder-/UID-Location.
- Ein globaler OpenRouter-Concurrency-Limiter teilt sich Worker, Sample und Eval; sehr konservatives Limit (vorzugsweise ein Request gleichzeitig) plus Retry-Backoff verhindert 429-Stürme. Fortschritt nur aggregiert loggen.

## Eval-Set und Eval-CLI

- Rund 30 synthetische, versionierte Beispiele für `security_auth`, Phishing/Scam, Prompt-Injection-Texte, Newsletter, transaktionale, persönliche/geschäftliche und Coverage-Fälle. Kein echtes Mailmaterial in Fixtures.
- Basis ist eine reproduzierbare JSONL-Datei plus erwartete Labels/Antworten; Änderungen an Modell oder `question_set_version` müssen mit demselben Set vergleichbar bleiben. Live-Eval wird manuell und mit Guthabenfreigabe ausgeführt, nicht in CI.
- Sehrfronts dokumentierte `evalAgent`-Route ist agentenzentriert, Jev ist aber eine normale SDK-Funktion. Vor der Integration den aktuellen `veryfront/eval`-Vertrag in Context7 und der installierten Version prüfen. Falls kein unterstützter Custom-Function-Adapter existiert, Jev nicht als Chat-Agent tarnen: vorhandenes `npm run eval` unverändert lassen und einen expliziten `eval:jev`-Runner ergänzen.

## Containerhärtung und Pin-Wartung

- Vor Erstellen des Dockerfiles `docker manifest inspect node:26.12.1-slim` ausführen und prüfen, dass die Zielplattformen, insbesondere `linux/arm64`, verfügbar sind. Bei fehlendem Tag nicht still auf eine andere Node-Version wechseln.
- Container als `USER node`; `/data` vorher `node:node`-Owner geben. Compose: `restart: unless-stopped`, Healthcheck gegen `/api/status`, `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`. Accounts-JSON ausschließlich read-only mounten, SQLite als Volume. Nur `127.0.0.1:3000:3000` am Host veröffentlichen.
- Exakter Node-Pin braucht Wartung: wöchentliche Dependabot-/Renovate-Updates für npm, Docker und GitHub Actions sowie einen CI-Pin-Test, der `.nvmrc`, `package.json` und Dockerfile abgleicht. Ein Teilupdate muss scheitern, bis alle Pins synchron sind.

## Sicherheitsregel für `security_auth`

- `category != security_auth` ist keine bestätigte Sicherheitsgarantie, solange unbekannt ist, ob SDK-Antwort `choice` die Top-Klasse oder auch Klassenwahrscheinlichkeiten liefert. Nicht vor dem Sample festlegen.
- Zeige bis zur Policy-Entscheidung `would_quarantine: pending_policy`; keine willkürliche Nebenklassen-Schwelle. Nach Sample legt Nico fest, ob jede `security_auth`-Klasse oder erst eine bestimmte Wahrscheinlichkeit fail-closed blockt. Bis dahin keinerlei Quarantäne-/Löschaktion.

## Quellen / Verifikation

- OpenRouter SDK und `DecisionsResponse`: Context7 Library-ID `/openrouterteam/typescript-sdk`.
- ImapFlow UIDVALIDITY, Mailbox-Locks, IDLE/Events und Timeout-Optionen: Context7 Library-ID `/postalsys/imapflow`.
- Veryfront Server/Evals: Context7 Library-ID `/websites/veryfront`.
- Die im Plan dokumentierten API-Semantiken vor Code gegen die tatsächlich installierten Typen und synthetische Response-Fixtures abgleichen; bei Abweichung zuerst Vertrag klären.
