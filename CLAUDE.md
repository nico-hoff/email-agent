@AGENTS.md

## Neue Session: zuerst lesen

1. `docs/README.md` (Index und Lesereihenfolge)
2. Neuestes `docs/HANDOVER_*.md` (aktuell `docs/HANDOVER_2026-10-31.md`): Stand, offene Arbeit, Werkzeug-Notizen, Push-Gate
3. `docs/ARCHITECTURE.md` (Aufbau) und `docs/adr/` (Entscheidungen; neue Entscheidung = neue ADR im selben Commit)

Verbindlich für jede Implementierungsarbeit in diesem Repo: `docs/IMPLEMENTATION_PLAN.md` (Abschnitt 3: Arbeitsregeln, harte Regeln H1–H10, STOP-Punkte), `docs/IMPLEMENTATION_PLAN_v4.md` (H11–H15), `docs/IMPLEMENTATION_PLAN_v5.md` (freigegebener Plan, H16–H22) und `docs/erd.md` (Schema). `.hermes/plans/*`, `HANDOVER.md` und ältere Handover sind überholt.

Freigaben von Nico (Stand 2026-10-31): `main` darf nach grünem Push-Gate vorgespult werden. Nur Nico: Live-Aufrufe (Jev, Agenten, IMAP), Secrets (auch `fly secrets`), `auto_actions` auf `live`, Konten-Datei hochladen.

## Externe Dokumentation: Context7 zuerst

Context7 ist die primäre Quelle für jede externe Doku (Veryfront, OpenRouter SDK, ImapFlow, mailparser, zod, Node, …). Vor jeder Nutzung einer externen API: `resolve-library-id`, dann `query-docs`. Bekannte IDs: `/websites/veryfront`, `/openrouterteam/typescript-sdk`, `/postalsys/imapflow`. Erst danach installierte Typdeklarationen und echte synthetische Fixtures (H6). Kein Raten aus dem Gedächtnis; Widersprüche → STOP-5.


## Code-Navigation: graphify zuerst

graphify (`graphifyy`, global per `uv tool install graphifyy`) ist die primäre Quelle für Fragen zur eigenen Codebasis, so wie Context7 für externe Doku. Der Graph liegt in `graphify-out/graph.json` (lokal, nicht committet).

- Vor dem ersten grep/Glob/Read zu einer Codebase-Frage: `graphify query "<frage>"`; Beziehungen mit `graphify path "<A>" "<B>"`, Konzepte mit `graphify explain "<X>"`. Rohdateien nur für die Stellen lesen, die der Graph genannt hat.
- Diese Regel gehört in jeden Subagent-Prompt, der Code erkundet.
- Nach Codeänderungen: `graphify update .` (nur AST, lokal, keine API-Kosten). Fehlt `graphify-out/`, so neu bauen.
- Datenschutz (H1/H3): nur der Code-Modus. Kein `graphify extract`, kein `/graphify` mit semantischer LLM-Extraktion und kein `graphify add <url>` ohne Nicos Freigabe. `.graphifyignore` schließt `data/`, `.env*`, `.mcp.json`, SQLite-Dateien, `node_modules/` und `.hermes/` aus.
