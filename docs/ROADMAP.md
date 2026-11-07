# Roadmap

> Stand 2026-11-01. Entscheidungen: ADR 0021–0045. Umgebungen: prod (fly), preview, QA und Staging auf Nicos Mac (ADR 0042). Jeder Meilenstein endet mit dem **QA-Loop** (ADR 0021): Checkliste + Screenshots + Preview-App → Nicos „go“ → `main` (= Prod-Deploy auf fly).
> Legende: 🤖 Agenten allein · 👤 Nico · ✅ fertig · 🟡 läuft · ⏳ offen

## Phase A – Grundlage und Prod-MVP

| Nr. | Meilenstein | Inhalt | Wer | Stand |
|---|---|---|---|---|
| R0 | Arbeitsweise | Branch `dev`, ADRs 0021–0028, Roadmap, `CLAUDE.md`-Freigaben | 🤖 | ✅ |
| R1 | Nutzerkonten | `users`, Sitzungen pro Nutzer, Einladungscodes, `npm run user:create`, Testnutzer im Dev, Migration mit `user_id` auf allen Nutzertabellen, Datenübernahme | 🤖 | ✅ `dev` (`docs/qa/R1.md`) |
| R2 | Postfächer in der App | Profil → Konten verwalten: Typ IMAP / Google (App-Passwort), verschlüsselt (`ACCOUNTS_ENCRYPTION_KEY`), „Verbindung testen“, Import der alten Konten-Datei, Worker liest aus der DB | 🤖 | ✅ `dev` (`docs/qa/R2.md`), dazu Erst-Import (`docs/qa/initial-import.md`) |
| R3 | Profil-Einstellungen | Auto-Aktionen pro Postfach: Spam als gelesen (aus/Trockenlauf/an), Not-Aus in der UI, Tageslimit sichtbar; Klassifikationsmodell pro Nutzer wählbar (ADR 0041) | 🤖 | ✅ `dev` (`docs/qa/R3.md`) |
| R4 | Prod-Pipeline | GitHub Environments `prod`/`preview`, Workflow „Secrets → fly“ und „Preview-App“, Katalog um neue Secrets erweitert | 🤖 + 👤 (Environments, `FLY_API_TOKEN`) | ✅ `dev` (`docs/qa/R4.md`); 👤 Environments/Secrets, `docs/qa/BLOCKERS.md` B1–B4 |
| R5 | Erster Prod-Deploy | fly `fra`, 512 MB, immer an, Volume, Snapshots Standard; Nico registriert sich, legt Postfächer an | 👤 nach QA-„go“ | ⏳ |

## Phase B – Nutzen

| Nr. | Meilenstein | Inhalt | Wer | Stand |
|---|---|---|---|---|
| R6 | Web-Push | VAPID, Abo pro Gerät, „wichtige Mail“ und „Briefing bereit“, nur Minimal-Metadaten | 🤖 | ✅ `dev` (`docs/qa/R6.md`); 👤 VAPID-Schlüssel, Test am iPhone |
| R7 | Kalibrierung v2 | Live-Proben und Evals mit synthetischen Daten (ADR 0028), Schwellen v2, `insights.md` | 🤖 | ✅ `dev` (`docs/qa/R7.md`, v2 Standard, ADR 0032) |
| R8 | Themen | Fragenset v3 mit `topic`-Choice (Alltagsthemen + eigene Liste), Probe, Eval, Profil → Themen, App-Ordner in der UI (Plan v5 M4) | 🤖 | ✅ `dev` (`docs/qa/R8.md`, Fragenset v3 hinter Schalter `topics_enabled`, Eval-Gate grün, ADR 0037) |
| R9 | Quarantäne und Papierkorb | Schreibport `move`, Quarantäne-Ordner, Aufräumen nach X Tagen (Standard 14), YOLO-Modus, Undo, Einstellungen (Plan v5 M7) | 🤖, Scharfschalten 👤 | ✅ `dev` (`docs/qa/R9.md`, alles aus; Scharfschalten 👤, ADR 0038) |
| R11 | Follow-ups und Erinnerungen | Tabelle `follow_ups`, Worker-Durchlauf, Web-Push, Agent-Tool `create_follow_up` mit Gate, UI „Erinnerungen“ (ADR 0030 Stufe 1) | 🤖 | ⏳ |
| R12 | Nutzer-Gedächtnis | `user_memories` + FTS5, Tools `add_memory`/`search_memory` mit Gate (Jev), Profil „Was der Agent über mich weiß“ (ADR 0031) | 🤖 | ⏳ |
| R10 | UI-Feinschliff | im QA-Loop mit Nico iterieren (Kopfzeile, Badges, Absender-Fragen, Profil-Flows) | 🤖 + 👤 | ⏳ |
| R13 | Postgres auf Neon | Schema 001–012 nach Postgres, asynchroner Datenzugriff, Query-Builder, RLS (App-Rolle ohne `BYPASSRLS`), Neon-Branches für Dev/Test, Staging, Prod; vor R5 (ADR 0048/0049) | 🤖, Neon-Zugang 👤 | ⏳ wartet auf `DATABASE_URL` |

## Phase C – go2market-Gate (nicht vor Nicos Entscheidung)

- OpenRouter-Datenschutz (Logging/Training aus) 👤
- Offene Registrierung, Datenschutzerklärung, AGB, Lösch- und Exportfunktion, AV-Verträge (fly, OpenRouter)
- Google OAuth (Cloud-Projekt, Gmail-Scope-Verifizierung) statt App-Passwort
- Mandantentrennung extern prüfen lassen, Backups/Restore üben, Monitoring
- Ggf. native App (eigene ADR)

## Für Nico (sammelt sich hier)

1. GitHub: Environments `prod` und `preview` anlegen, Secrets eintragen (`OPENROUTER_API_KEY`, `ACCOUNTS_ENCRYPTION_KEY`, `FLY_API_TOKEN`, später `VAPID_*`).
2. Claude-Cloud-Umgebung: `OPENROUTER_API_KEY` als Umgebungs-Secret, damit Agenten R&D-Proben fahren können (ADR 0028).
3. Dev-Rechner (Mac/Pi): `git checkout dev`, `.env.local` mit `ACCOUNTS_ENCRYPTION_KEY` (`openssl rand -base64 32`), `tailscale serve --bg 3000`.
4. QA-Loops: Preview-Link öffnen, „go“ oder Mängelliste.
5. Nach R5: Postfächer in der App anlegen, Trockenlauf prüfen, Aktionen selbst scharf schalten.
6. Neon (R13, ADR 0049): Projekt in Region Frankfurt anlegen, die Verbindungs-URL als `DATABASE_URL` selbst in `.env.local` eintragen (nicht in den Chat). Für Cloud-Agenten als Umgebungs-Secret.
