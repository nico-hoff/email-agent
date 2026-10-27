# E-Mail-Agent

Lokaler Dienst, der mehrere IMAP-Postfächer **nur lesend** abruft, jede Mail mit Jev (OpenRouter, System One `typesafe/jev-1.13`) klassifiziert und die Antworten in SQLite speichert. Ein Review-Dashboard zeigt Ergebnisse und Abweichungen zum Provider-Spamfilter.

**Status: Beobachtungsmodus.** Es gibt keine Produktionsfreigabe. Der Agent verschiebt, löscht, markiert oder beantwortet keine Mails und legt keine Entwürfe an. Die Spam-Quarantäne läuft nur als Shadow-Regel (Kandidat und Entscheidung werden protokolliert, nichts wird ausgeführt). Eine Schreibfreigabe erfordert eine eigene, bewusste Entscheidung nach Auswertung der Beobachtungsphase.

## Lokale Einrichtung

1. Node 26.12.1 exakt (siehe `.nvmrc`), z. B. mit fnm: `fnm install 26.12.1 && fnm use`.
2. `npm install`
3. `cp .env.example .env.local` und `OPENROUTER_API_KEY` eintragen. `.env.local` ist von Git ignoriert.
4. Konten-Datei anlegen: `mkdir -p data && cp docs/accounts.example.json data/accounts.json`, Platzhalter ersetzen, dann `chmod 600 data/accounts.json`. Die Datei ist von Git ignoriert und wird nie ausgegeben oder committet.
5. `npm run dev:live` startet Server, IMAP-Worker und Klassifizierung mit der echten Datenbank (Bindung standardmäßig `127.0.0.1`). `npm run dev` startet dagegen immer mit synthetischen Daten, siehe Abschnitt Entwicklung.

Endpunkte: Dashboard `/`, `GET /api/emails`, `GET /api/status`, `GET /api/health` (offen), Anmeldung unter `/welcome` und `/api/auth/*`. Alles außer Health und Welcome verlangt eine Session (siehe Zugang).

## Zugang über das Tailnet (Tailscale Serve)

Die App bindet immer an `127.0.0.1` (nie `0.0.0.0`). Von außen kommt man nur über `tailscale serve`, das HTTPS im Tailnet bereitstellt (nötig für Service Worker und PWA auf dem iPhone) und die Identität als Header `Tailscale-User-Login` mitgibt. Hintergrund und Quellen: `docs/access-contract.md`.

1. Tailscale auf dem Host und auf dem iPhone installieren, beide im selben Tailnet. HTTPS-Zertifikate und MagicDNS in der Tailscale-Admin-Konsole aktivieren.
2. App starten (`npm run start` oder `docker compose up -d`, Port 3000 nur auf `127.0.0.1`).
3. `tailscale serve --bg 3000` (Hintergrundbetrieb; Status mit `tailscale serve status`, abschalten mit `tailscale serve reset`). **Nie** `tailscale funnel` verwenden: Funnel ist öffentlich und liefert keine Identität.
4. Allowlist anlegen (ohne sie ist niemand zugelassen): `data/auth-allowlist.json` mit `{"logins": ["dein-login@example.com"]}`, `chmod 600`. Bei Docker liegt sie im Volume `/data`, z. B. `docker compose cp auth-allowlist.json email-agent:/data/auth-allowlist.json`. Änderungen gelten sofort, auch für bestehende Sitzungen. Das Geheimnis `auth-secret` entsteht beim ersten Start von selbst (0600, nie committen).
5. Auf dem iPhone `https://<gerät>.<tailnet>.ts.net` öffnen, "Login" tippen, dann "Zum Home-Bildschirm". Die Session gilt 30 Tage; Abmelden per `POST /api/auth/logout`.

`npm run dev` (synthetisch) braucht kein Tailscale: Der Login-Knopf meldet dort als `dev@synthetic.invalid` an.

## Datenschutz

- Gespeichert werden nur Metadaten (Absender, Betreff, Zeitstempel, Ordner/UID) und Jev-Antworten. Kein Mailtext, kein Auszug, keine Rohquelle, keine Roh-Response.
- Mailinhalte erscheinen nie in Logs, API oder Dashboard. Testdaten sind ausschließlich synthetisch.
- IMAP-Zugriff ist schreibgeschützt (read-only).
- Zugangsdaten liegen nur in `.env.local` und `data/accounts.json` (Modus 0600).

## Stichprobe und Evaluation

- `npm run sample` zeigt zunächst nur eine **Vorschau** (Anzahl, keine Jev-Aufrufe). Erst `npm run sample -- --account <id> --limit-per-folder 200 --confirm <N>` (N = Zahl aus der Vorschau) ruft Jev tatsächlich auf. Weitere Optionen: `scripts/sample.ts`.
- `npm run eval:jev` führt die Evaluation gegen das synthetische Set `tests/fixtures/eval/email-eval-v1.jsonl` aus (Live-Aufrufe an Jev, verursacht Kosten; erfordert `--confirm-live`, im Script gesetzt).
- Wiederholbare Evals auf öffentlichen synthetischen Datensätzen (Details, Mapping und Statistik: `docs/eval-datasets.md`). Ablauf: (1) `npm run eval:fetch` lädt **alle** Zeilen beider Quellen nach `data/eval-datasets/` (gitignored), entfernt exakte Dubletten und schreibt Klassenverteilung und Revision ins Manifest (`--max-rows N` nur für Tests/Debug). (2) Jede Mail liegt über einen Inhalts-Hash fest in `calib` (30 %) oder `test` (70 %). Dreimal `npm run eval:jev -- --source hf --seed 1 --n 100` (Seeds 1, 2, 3; Standard `--split test --strategy balanced`; Grenze 200 Aufrufe je Lauf, optional `--max-cost <USD>`). (3) `npm run eval:compare` vergleicht die Läufe (Mittelwert, min, max, Standardabweichung je Frage, Gesamtkosten) und schreibt `data/eval-runs/insights.md` (Trefferquote mit 95-%-Wilson-Intervall, Konfusionsmatrix, Precision/Recall/F1, Balanced Accuracy, ROC-AUC, Schwellen-Tabelle, Stichprobenbeschreibung; nur Aggregate und Fall-IDs; Pfad mit `--md <datei>`, `--no-md` schaltet ab). Kalibrierung der Schwellen getrennt: `npm run eval:jev -- --source hf --seed 1 --n 100 --split calib`. Schwellen werden nur auf `calib` gewählt, berichtet wird auf `test`. Laufberichte liegen in `data/eval-runs/` und enthalten nur IDs, erwartete Werte, Antworten, Treffer, Kosten und Stichprobenzähler. Ein Lauf mit 100 Mails kostet laut echter Fixture rund 0,00005 $ pro Mail; Live-Läufe startet Nico.
- Mit `--source hf` schreibt `eval:jev` nach dem Lauf die Fälle samt normalisierten Antworten (und `shadow_quarantine`) zusätzlich in die getrennte Dev-Datenbank `data/dev-synthetic.sqlite`, damit `npm run dev` sie zeigt. Ein erneuter Lauf mit derselben Mail, demselben Fragenset und Modell ersetzt die Antworten (der letzte Lauf gewinnt). Abschalten mit `--no-dev-db`. Die Auditzeile `eval_run` jedes Eval-Laufs (auch des festen Sets) geht ausschließlich in diese Dev-Datenbank; die echte Datenbank wird von keinem Eval-Skript geöffnet.
- `npm run agent:probe -- --confirm-live` macht genau einen Live-Aufruf des Antwort-Agenten (`openai/gpt-6-luna` über OpenRouter) mit einer fest eingebauten synthetischen Mail und gibt nur Struktur, Modell, Latenz und Tokens aus (den synthetischen Entwurf nur mit `--show-draft`). Speichert nichts; erfordert `OPENROUTER_API_KEY` (daraus werden `OPENAI_API_KEY` und `OPENAI_BASE_URL` abgeleitet, falls nicht gesetzt). Kosten laut OpenRouter: 0,10 $/M Input, 0,50 $/M Output.
- `npm run calibrate` liest nur die lokale Datenbank und zeigt je `noul`-Frage die Verteilung (min, p10, Median, p90, max) getrennt nach Provider-Posteingang und -Spam-Ordner sowie Precision und Recall gegen das Provider-Label für Schwellen von 0.50 bis 0.95. Nur Aggregate, nie Betreff oder Absender. Optionen: `--question-set <version>`, `--account <id>`, `--json`.

## Entwicklung

- `npm run typecheck`, `npm test`, `npm run build`.
- `npm run dev` läuft **immer synthetisch**: `DATABASE_PATH` wird auf `data/dev-synthetic.sqlite` gesetzt, IMAP-Worker und Klassifizierung sind aus (auch wenn `ACCOUNTS_FILE` in `.env.local` steht). Die Startzeile zeigt `workers=disabled data=synthetic`. Echte Daten bleiben strikt getrennt; eine Schutzprüfung verweigert das Schreiben synthetischer Daten in jede Datenbank mit Nicht-Synthetik-Konten (synthetisch = Konto-ID `hf-*` und Host `synthetic.invalid`).
- Dev-Daten füllen: `npm run eval:fetch && npm run dev:seed`. `dev:seed` importiert alle geladenen (entdublierten) Fälle beider Partitionen aus `data/eval-datasets/` ohne Jev-Aufruf (kostenlos, wiederholbar): je Quelle ein Konto (`hf-triage`, `hf-sinabis`), Mail mit Fall-ID als Message-ID, Absender `noreply@<Domäne>`, Betreff aus dem Fall, Empfangszeit deterministisch über die letzten 14 Tage verteilt, Ordner `Junk` bei erwartetem Spam/Phishing, sonst `INBOX`. Kein Body, kein Auszug. Ohne Jev-Antworten haben die Mails keine Klassifikation (Dashboard: `-`). Ist die Dev-DB leer, startet die App trotzdem und weist auf diese Befehle hin.
- `npm run dev:live`: bisheriges Verhalten (`.env.local`, echte Datenbank, Worker nur wenn die Konten-Datei existiert). `npm run start` (Produktion/Docker) ist unverändert.
- Im Entwicklungsmodus warnt der Start einmal, wenn Agent-Worktrees unter `.claude/worktrees/` eigene `node_modules` haben: Veryfront überschreitet dann das CSS-Kandidatenlimit und liefert keine Styles. Betroffene Worktrees mit `git worktree remove` entfernen, nachdem ungesicherte Arbeit geprüft wurde.
- Code-Navigation: `graphify query "<Frage>"` bzw. `graphify update .` (Graph in `graphify-out/`, ignoriert; nie `graphify extract`/`add`, um keine Daten zu übertragen).
- Verbindliche Regeln: `docs/IMPLEMENTATION_PLAN.md`, Schema `docs/erd.md`, Abweichungen `docs/DEVIATIONS.md`.
