# 0019 Orchestrator + Subagenten, Push-Gate

- Status: angenommen
- Datum: 2026-10-29
- Bezug: `docs/HANDOVER_2026-10-31.md` §Arbeitsweise, `CLAUDE.md`

## Kontext
Entwicklung läuft überwiegend durch Claude-Sessions. Mehrere Agenten parallel sind schnell, aber riskant.

## Entscheidung
Ein Orchestrator plant und reviewt. Sonnet-Subagenten bauen in eigenen Worktrees (erst Fast-Forward auf `main`, `npm ci`). Haiku recherchiert und prüft nur lesend. Der Orchestrator liest jeden Diff, übernimmt per Cherry-Pick/Fast-Forward, committet nur benannte Dateien (nie `git add -A`) und pusht nur, wenn **im selben Befehl** grün sind: `npm run typecheck && npm test && npm run build && npm run eval && npm run smoke:e2e`. Worktrees nach dem Merge sofort löschen (Veryfront-CSS-Scanner).

## Folgen
- `main` ist immer grün; Nico hat das Vorspulen von `main` freigegeben.
- Live-Aufrufe, Secrets, `live`-Modus und fly-Secrets bleiben Nico vorbehalten.
