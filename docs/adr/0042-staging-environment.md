# 0042 Staging auf Nicos Mac: echte Postfächer, eigene Datenbank, Tailnet

- Status: angenommen
- Datum: 2026-10-31
- Bezug: Wunsch Nico 2026-10-31 („Lets call it staging“), ergänzt 0021 (prod/dev/preview), 0022, 0023, 0028

## Kontext
Die QA (`npm run qa:serve`) ist rein synthetisch und soll es bleiben. Nico will vor Prod (R5) ein echtes IMAP-Konto in der App hinterlegen und den Echtbetrieb am iPhone prüfen, ohne synthetische und echte Daten zu mischen.

## Entscheidung
| Umgebung | Start | Datenbank | Postfächer | Erreichbar |
|---|---|---|---|---|
| **qa** | `npm run qa:serve` (Port 3100) | `data/qa-synthetic.sqlite` | keine, nur synthetische Mails, Antworten simuliert | Tailnet `https://<mac>.ts.net` |
| **staging** | `npm run staging` (Port 3200) | `data/staging.sqlite` | echt, nur in der App angelegt (verschlüsselt, 0023) | Tailnet `https://<mac>.ts.net:8443` |

- Staging ist der echte Server im Nutzer-Modus (`AUTH_MODE=users`), Loopback-Listener hinter Tailscale Serve (`VERYFRONT_TRUST_FORWARDED_HEADERS=1`). IMAP-Worker und Jev laufen live; Auto-Aktionen bleiben, wie das Konto sie hat (neu: aus), bis Nico sie selbst schaltet (0025).
- Staging liest **keine** Konten-Datei (kein Import nach 0023), Postfächer kommen nur aus der App. Der erste Nutzer entsteht mit `npm run staging:user -- --email …` (übernimmt die Owner-Zeile der Staging-DB).
- Nur Nico legt echte Postfächer an und startet Staging mit ihnen; Agenten starten Staging nur ohne Postfächer (Smoke) und lesen dessen Datenbank nicht.
- Beide Startskripte prüfen Node 26.12.1 nativ (arm64) und einen freien Port, bevor sie starten.

## Folgen
- Drei getrennte Datenbanken auf dem Mac (QA, Staging, ggf. `dev:live`); echte Metadaten liegen nur in Staging bzw. Prod.
- Staging läuft im Entwicklungsmodus des Servers (ohne Build); prod-identisch ist erst die Preview-App bzw. fly.
