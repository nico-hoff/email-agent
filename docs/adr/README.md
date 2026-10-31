# Architecture Decision Records

Kurze Entscheidungsprotokolle: **Kontext → Entscheidung → Folgen**. Eine Datei pro Entscheidung, fortlaufend nummeriert. Eine ADR wird nicht umgeschrieben, sondern durch eine neue ersetzt (`Status: ersetzt durch 00NN`).

Neue ADR: nächste freie Nummer, Vorlage unten, Eintrag in dieser Tabelle, im selben Commit wie die Änderung, die sie begründet.

| Nr. | Titel | Status |
|---|---|---|
| [0001](0001-veryfront-single-process.md) | Veryfront, ein Prozess | angenommen |
| [0002](0002-node-26-npm-erasable-ts.md) | Node 26.12.1, npm, löschbares TypeScript | angenommen |
| [0003](0003-sqlite-migrations-erd.md) | SQLite, nummerierte Migrationen, ERD als Wahrheit | angenommen |
| [0004](0004-no-mail-content-persisted.md) | Keine Mailinhalte speichern, nur synthetische Fixtures | angenommen |
| [0005](0005-imap-readonly-seen-port.md) | IMAP lesend, eigener Schreibport nur für `\Seen` | angenommen |
| [0006](0006-jev-system-one.md) | Jev über System One, versionierte Fragensets | angenommen |
| [0007](0007-calibration-config.md) | Kalibrierung als versionierte Konfiguration, ungemappt = fail-closed | angenommen |
| [0008](0008-shadow-decision.md) | Schatten-Entscheidung, `security_auth` nie Kandidat | angenommen |
| [0009](0009-agents-openrouter.md) | Agenten über OpenRouter mit `OPENAI_*`-Ableitung | angenommen |
| [0010](0010-agent-safety.md) | Agenten-Sicherheit: Gate, Metadaten-Briefing, Entwürfe ungespeichert | angenommen |
| [0011](0011-access-guard-interceptor.md) | Zugangsmodi, Guard als `requestInterceptor`, keine `middleware.ts` | angenommen |
| [0012](0012-csrf-rate-limits.md) | Doppeltes CSRF-Token, Rate-Limits im Speicher | angenommen |
| [0013](0013-synthetic-dev-db.md) | Synthetische Dev-DB als Standard | angenommen |
| [0014](0014-evals.md) | Evals: HF-Datensets, calib/test, Offline-Gates | angenommen |
| [0015](0015-ui-pwa.md) | UI: React ohne UI-Framework, PWA, SW cacht nur die Shell | angenommen |
| [0016](0016-auto-actions.md) | Auto-Aktionen: Trockenlauf-Standard, Not-Aus, Undo | angenommen |
| [0017](0017-sender-rules-hitl.md) | Absender-Regeln und HITL nach drei Spam-Urteilen | angenommen |
| [0018](0018-hosting.md) | Hosting: gehärtetes Docker, fly.io fra mit Volume | angenommen (fly.toml in Arbeit) |
| [0019](0019-agentic-workflow.md) | Orchestrator + Subagenten, Push-Gate | angenommen |
| [0020](0020-single-user-future-accounts.md) | Single-User jetzt; Konten in der UI / Multi-User später | vorgeschlagen |

## Vorlage

```markdown
# 00NN Titel

- Status: vorgeschlagen | angenommen | ersetzt durch 00MM
- Datum: JJJJ-MM-TT
- Bezug: Plan-Nummern (E/D/H/T), Verträge, Dateien

## Kontext
## Entscheidung
## Folgen
```
