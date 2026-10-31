# 0024 Secrets pro Umgebung: GitHub Environments → fly

- Status: angenommen
- Datum: 2026-10-31
- Bezug: 0021, `scripts/fly-secrets.ts`, `Makefile`

## Kontext
Secrets sollen pro Umgebung zentral liegen, nicht im Repo-Inhalt und nicht nur auf Nicos Mac.

## Entscheidung
- **prod:** Quelle sind die verschlüsselten Secrets des GitHub-Environments `prod` (Repo-Einstellungen, nicht Repo-Inhalt). Ein manueller Workflow (`workflow_dispatch`, Environment `prod` mit Freigabe durch Nico) übergibt sie per `scripts/fly-secrets.ts sync --force` an fly. Dafür braucht das Environment zusätzlich `FLY_API_TOKEN` (deploy-scoped).
- **preview:** Environment `preview` analog, mit synthetischen Werten.
- **dev:** `.env.local` auf dem Dev-Rechner; `make fly-secrets-*` bleibt für Handarbeit.
- Katalog im Skript: `APP_PASSWORD` (bis 0022 fertig), `OPENROUTER_API_KEY`, `ACCOUNTS_ENCRYPTION_KEY`, optional `OPENAI_API_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`.

## Folgen
- Kein Secret im Git-Inhalt, kein Secret in Workflow-Logs (nur Namen).
- Nico legt Environments und Werte in GitHub an; Agenten sehen die Werte nie.
