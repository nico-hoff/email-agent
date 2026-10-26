# E-Mail-Agent

Lokaler Dienst, der mehrere IMAP-Postfächer **nur lesend** abruft, jede Mail mit Jev (OpenRouter, System One `typesafe/jev-1.13`) klassifiziert und die Antworten in SQLite speichert. Ein Review-Dashboard zeigt Ergebnisse und Abweichungen zum Provider-Spamfilter.

**Status: Beobachtungsmodus.** Es gibt keine Produktionsfreigabe. Der Agent verschiebt, löscht, markiert oder beantwortet keine Mails und legt keine Entwürfe an. Die Spam-Quarantäne läuft nur als Shadow-Regel (Kandidat und Entscheidung werden protokolliert, nichts wird ausgeführt). Eine Schreibfreigabe erfordert eine eigene, bewusste Entscheidung nach Auswertung der Beobachtungsphase.

## Lokale Einrichtung

1. Node 26.12.1 exakt (siehe `.nvmrc`), z. B. mit fnm: `fnm install 26.12.1 && fnm use`.
2. `npm install`
3. `cp .env.example .env.local` und `OPENROUTER_API_KEY` eintragen. `.env.local` ist von Git ignoriert.
4. Konten-Datei anlegen: `mkdir -p data && cp docs/accounts.example.json data/accounts.json`, Platzhalter ersetzen, dann `chmod 600 data/accounts.json`. Die Datei ist von Git ignoriert und wird nie ausgegeben oder committet.
5. `npm run dev` startet Server, IMAP-Worker und Klassifizierung (Bindung standardmäßig `127.0.0.1`).

Endpunkte: Dashboard `/`, `GET /api/emails`, `GET /api/status`, `GET /api/health`.

## Datenschutz

- Gespeichert werden nur Metadaten (Absender, Betreff, Zeitstempel, Ordner/UID) und Jev-Antworten. Kein Mailtext, kein Auszug, keine Rohquelle, keine Roh-Response.
- Mailinhalte erscheinen nie in Logs, API oder Dashboard. Testdaten sind ausschließlich synthetisch.
- IMAP-Zugriff ist schreibgeschützt (read-only).
- Zugangsdaten liegen nur in `.env.local` und `data/accounts.json` (Modus 0600).

## Stichprobe und Evaluation

- `npm run sample` zeigt zunächst nur eine **Vorschau** (Anzahl, keine Jev-Aufrufe). Erst `npm run sample -- --account <id> --limit-per-folder 200 --confirm <N>` (N = Zahl aus der Vorschau) ruft Jev tatsächlich auf. Weitere Optionen: `tools/sample.ts`.
- `npm run eval:jev` führt die Evaluation gegen das synthetische Set `tests/fixtures/eval/email-eval-v1.jsonl` aus (Live-Aufrufe an Jev, verursacht Kosten; erfordert `--confirm-live`, im Script gesetzt).

## Entwicklung

- `npm run typecheck`, `npm test`, `npm run build`.
- Code-Navigation: `graphify query "<Frage>"` bzw. `graphify update .` (Graph in `graphify-out/`, ignoriert; nie `graphify extract`/`add`, um keine Daten zu übertragen).
- Verbindliche Regeln: `docs/IMPLEMENTATION_PLAN.md`, Schema `docs/erd.md`, Abweichungen `docs/DEVIATIONS.md`.
