# Dokumentation

## Lesereihenfolge für eine neue Session

1. `CLAUDE.md` und `AGENTS.md` — harte Regeln (Datenschutz, Secrets, Git, Context7, graphify).
2. **`docs/HANDOVER_2026-10-31.md`** — aktueller Stand, was in Arbeit ist, nächste Schritte, Werkzeug-Notizen.
3. **`docs/ROADMAP.md`** — Meilensteine R0–R10, go2market-Gate, Liste für Nico. Laufender Agenten-Auftrag: `docs/GOAL.md`.
4. **`docs/ARCHITECTURE.md`** — wie das System gebaut ist (Komponenten, Datenfluss, Laufzeitmodi, Sicherheit, Deployment).
5. **`docs/adr/`** — warum es so gebaut ist (0001–0031). Veryfront-Bausteine, Tipps und Fallstricke: **`docs/veryfront-guide.md`**.
6. Bei Bedarf der passende Vertrag (unten) und `docs/erd.md` vor jeder Schemaänderung.

Neuere Handover ersetzen ältere; immer das mit dem jüngsten Datum lesen.

## Verbindlich

| Datei | Inhalt |
|---|---|
| `docs/IMPLEMENTATION_PLAN.md` | §3 Arbeitsregeln H1–H10, STOP-Punkte |
| `docs/IMPLEMENTATION_PLAN_v4.md` | H11–H15 (Schatten-Entscheidung) |
| `docs/IMPLEMENTATION_PLAN_v5.md` | freigegebener Plan: M1–M8, E1–E12, D22–D29, H16–H22, T46–T64 |
| `docs/erd.md` | Schema, Quelle der Wahrheit |
| `docs/DEVIATIONS.md` | dokumentierte Abweichungen vom Plan |

## Verträge

| Datei | Thema |
|---|---|
| `docs/jev-contract.md` | Jev/System One, Fragensets |
| `docs/agent-contract.md` | Agenten, Briefing/SSE (§6), Evals (§7) |
| `docs/imap-write-contract.md` | `\Seen`-Schreibport |
| `docs/access-contract.md` | Zugang: synthetic, password, tailnet |
| `docs/accounts-contract.md` | Postfächer in der App: Verschlüsselung, Supervisor, Import, API, Grenzen (R2) |
| `docs/eval-datasets.md` | HF-Datensets, Splits, Kalibrierung |

## Betrieb

| Datei | Thema |
|---|---|
| `README.md` | Installation, Befehle, „Öffentlich hosten“ |
| `docs/fly-deploy.md` | fly.io: Konfiguration, Schritte, Kosten, Backup, Not-Aus |
| `docs/github-environments.md` | GitHub Environments `prod`/`preview`, Secrets, Workflows (ADR 0024) |
| `docs/qa/R4.md` | QA-Paket R4: Prod-Pipeline |
| `docs/LOCAL_DEV_MAC.md` | lokal auf dem Mac, Live-Betrieb, Live-Proben |
| `docs/accounts.example.json` | Beispiel Konten-Datei (echte nie lesen/committen) |

## Historie (nicht mehr maßgeblich)

`docs/HANDOVER_2026-10-30.md`, `docs/HANDOVER_2026-10-27.md`, `HANDOVER.md` (Wurzel), `.hermes/plans/*`, `docs/ITERATION_2_NOTES.md`, `docs/KICKOFF_PROMPT.md`, `docs/E-Mail-Agent – Blueprint (…).md`.
