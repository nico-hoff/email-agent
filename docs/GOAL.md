# Goal-Auftrag: Roadmap R1–R9 auf `dev`

> Ausführliche Fassung des `/goal`-Auftrags (die Goal-Bedingung selbst ist auf 4000 Zeichen begrenzt und verweist hierher).

## Ziel und Abschluss

Baue die Roadmap-Meilensteine **R1, R2, R3, R4, R6, R7, R8, R9** aus `docs/ROADMAP.md` so weit fertig, wie es ohne Nico geht, jeweils mit grünem Push-Gate auf `dev` und einem QA-Paket pro Meilenstein. Fertig ist das Ziel, wenn jeder dieser Meilensteine entweder auf `dev` umgesetzt ist (Code, Tests, Doku, ADR-konform, QA-Paket vorhanden) oder in `docs/qa/BLOCKERS.md` mit genauem Grund und dem nötigen Schritt von Nico steht.

## Einstieg (in dieser Reihenfolge lesen)

`CLAUDE.md`, `AGENTS.md`, `docs/README.md`, neuestes `docs/HANDOVER_*.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/adr/` (besonders 0021–0028), vor Schemaarbeit `docs/erd.md`, dann die Verträge `docs/*-contract.md`. Bei Widerspruch gilt die neuere ADR, sonst STOP und in `docs/qa/BLOCKERS.md` notieren.

## Harte Regeln

- Nur auf `dev` pushen, und nur, wenn im selben Befehl grün: `npm run typecheck && npm test -- --test-reporter=spec tests/*.test.ts` (Ausgabe enthält `ℹ fail 0`) `&& npm run build && npm run eval && npm run smoke:e2e`. **Nie** auf `main` pushen oder mergen (`main` = Prod, fly deployt automatisch). Nie `git add -A`, nur benannte Dateien. Commit-Trailer wie in der Git-Historie.
- `.env`, `.env.local`, `.mcp.json`, Konten-Dateien nie lesen, ausgeben, committen. Skripte dürfen sie laden (`node --env-file-if-exists=.env.local`).
- Keine Mailinhalte speichern, loggen, ausgeben oder in Fixtures (ADR 0004). Fixtures und Evals nur synthetisch.
- Live-Aufrufe (Jev, Agenten-Modelle über OpenRouter) für R&D erlaubt, nur mit synthetischen Inhalten (ADR 0028). Nie echte Postfächer per IMAP, nie Auto-Aktionen scharf schalten, keine wirkenden `fly`-Befehle (deploy/secrets/volumes), keine GitHub-Environment-Secrets setzen: das macht Nico.
- IMAP-Schreiben nur über `lib/imap-write.ts` und nur die Aktionen aus ADR 0025 (`\Seen`, Verschieben in Quarantäne, Verschieben in den Papierkorb); nie EXPUNGE, nie senden; alles standardmäßig aus.
- Node exakt 26.12.1 (`nvm use`), npm. Von Node ausgeführter Code importiert mit `.ts`-Endung, nur löschbare TS-Syntax.
- Externe APIs: erst Context7, dann installierte Typen, dann synthetische Fixture. Nichts aus dem Gedächtnis.
- Codebase-Fragen zuerst `graphify query/path/explain`, nach Änderungen `graphify update .`; kein `graphify extract`/`add`.
- Schemaänderung = neue Migration + `docs/erd.md` + Schema-Test im selben Commit. Neue Entscheidung = neue ADR im selben Commit.
- Keine Root-`middleware.ts` (Guard bleibt `requestInterceptor`).

## Arbeitsweise

Orchestrieren. Subagenten in eigenen git-Worktrees (Sonnet baut, Haiku recherchiert/prüft lesend); jeder Worktree startet mit Fast-Forward auf `dev` und `npm ci`. Jeden Diff selbst lesen, per Cherry-Pick/Fast-Forward übernehmen, Worktrees sofort nach dem Merge löschen (Veryfront-CSS-Scanner). UI nur ein Agent gleichzeitig. Migrationsnummern vor parallelen Aufgaben zuteilen. Docker-Smoke (`npm run smoke:docker`) vor Änderungen an Dockerfile/Start/Auth. Subagent am Rate-Limit → per SendMessage fortsetzen.

## Meilensteine

- **R1 Nutzerkonten (ADR 0022):** `users`, Sitzungen pro Nutzer, Einladungscodes, `npm run user:create`, Testnutzer automatisch im Dev, `user_id` auf allen Nutzertabellen, Migration bestehender Daten auf einen Nutzer, strikte Trennung pro Nutzer in jeder Abfrage (Tests). `APP_PASSWORD`/Tailnet bleiben übergangsweise lauffähig.
- **R2 Postfächer in der App (ADR 0023):** Profil → Konten verwalten, Typen IMAP und Google (IMAP + App-Passwort, Voreinstellung `imap.gmail.com`), AES-256-GCM mit `ACCOUNTS_ENCRYPTION_KEY` + `key_id`, „Verbindung testen“ (nur gegen lokalen Test-IMAP oder gemockt), Import der alten Konten-Datei, Worker liest aus der DB, fail-closed ohne Schlüssel.
- **R3 Profil-Einstellungen (ADR 0025 Teil 1):** Spam als gelesen pro Postfach aus/Trockenlauf/an, Not-Aus und Tageslimit in der UI.
- **R4 Prod-Pipeline (ADR 0024):** Workflows „Secrets → fly“ (`workflow_dispatch`, Environment `prod`, `scripts/fly-secrets.ts sync --force`) und Preview-App; Katalog um `ACCOUNTS_ENCRYPTION_KEY`, `VAPID_*` erweitern; Doku, was Nico in GitHub anlegt. Nicht ausführen.
- **R6 Web-Push (ADR 0027):** VAPID, Abos pro Gerät/Nutzer, „wichtige Mail“ und „Briefing bereit“, nur Minimal-Metadaten.
- **R7 Kalibrierung v2 (ADR 0007, 0028):** Live-Proben und Evals mit synthetischen HF-Daten, Schwellen v2 (calib/test), `insights.md`.
- **R8 Themen (ADR 0026):** Fragenset v3 mit `topic`-Choice (Alltagsthemen + eigene Liste), vorher Live-Probe zur Optionszahl, Profil → Themen, App-Ordner in der UI, hinter Schalter bis Eval grün.
- **R9 Quarantäne/Papierkorb (ADR 0025 Teil 2):** Schreibport `move`, Ordner Quarantäne, Aufräumen nach X Tagen (Standard 14), YOLO, Undo, alles standardmäßig aus.

## QA-Paket pro Meilenstein

`docs/qa/R<n>.md`: was neu ist, Klick-Checkliste für Nico am iPhone, Screenshots aus dem synthetischen Dev-Modus (Playwright), bekannte Grenzen. Nicht auf Nicos „go“ warten: nächsten Meilenstein beginnen, `main` bleibt unberührt.

## Abschluss

Neues `docs/HANDOVER_<datum>.md` (ersetzt das alte), `docs/ROADMAP.md`-Status aktualisieren, `docs/qa/BLOCKERS.md` mit allem, was Nico tun muss, alles auf `dev` gepusht.
