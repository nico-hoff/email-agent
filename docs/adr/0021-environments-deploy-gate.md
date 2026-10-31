# 0021 Umgebungen, Deploy-Gate und QA-Loop

- Status: angenommen
- Datum: 2026-10-31
- Bezug: ersetzt in 0019 das Vorspulen von `main`; 0018, `fly.toml`

## Kontext
fly.io ist per GitHub-Integration mit `nico-hoff/email-agent` verbunden und deployt jeden Push auf `main`. Bisher hat der Orchestrator `main` nach grünem Push-Gate vorgespult. Nico will Prod und Dev trennen und UI-Qualität mit sich im Loop prüfen.

## Entscheidung
| Umgebung | Branch | Läuft auf | Daten |
|---|---|---|---|
| **prod** | `main` | fly.io, `fra`, `shared-cpu-1x` 512 MB, immer an, 1-GB-Volume, Standard-Snapshots (5 Tage) | echt |
| **dev** | `dev` | Nicos Mac oder Raspberry Pi, erreichbar über Tailscale | echt (Nico) oder synthetisch |
| **preview** | Feature-Stand | eigene, kurzlebige fly-App, synthetische Daten, eigenes Passwort | synthetisch |

- Agenten pushen nur auf `dev` (und den Session-Branch). `main` bekommt nur Stände, für die Nico im QA-Loop „go“ gesagt hat.
- **QA-Loop pro Meilenstein:** Checkliste + Screenshots + Link auf eine Preview-App → Nico testet am Handy → „go“ oder Mängelliste → nach „go“ Fast-Forward `main` (= Prod-Deploy) und Preview-App löschen.
- Das Push-Gate (0019) gilt unverändert für jeden Push auf `dev`.

## Folgen
- Ein versehentlicher Push auf `main` ist ein Prod-Deploy; deshalb nie ohne „go“.
- Preview-Apps kosten nur, solange sie laufen; nach dem Test löschen.
