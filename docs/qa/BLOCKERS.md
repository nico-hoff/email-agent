# Blocker und Schritte für Nico

> Stand 2026-11-01. Alles, was Agenten nach `CLAUDE.md`, `docs/GOAL.md` und ADR 0021/0024/0028 **nicht** tun dürfen oder können. Je Punkt: Grund und der nötige Schritt. Erledigtes abhaken und den Stand ins nächste Handover übernehmen.

## Zugänge und Secrets (R4, R5)

| # | Was | Grund | Schritt von Nico |
|---|---|---|---|
| B1 | GitHub-Environments `prod` und `preview` anlegen, `prod` mit dir als Required reviewer | Repo-Einstellungen, Agenten setzen keine Secrets (ADR 0024) | Anleitung `docs/github-environments.md` |
| B2 | Secrets in `prod`: `FLY_API_TOKEN` (`fly tokens create deploy -a email-agent`), `OPENROUTER_API_KEY`, `ACCOUNTS_ENCRYPTION_KEY` (`openssl rand -base64 32`, im Passwort-Manager sichern), `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (`npm run push:keys`, Subject = `mailto:` deiner Adresse, Paar aus demselben Lauf), `APP_PASSWORD` nur noch für den Übergang | Secret-Werte nur durch Nico | `docs/github-environments.md`, dann Workflow „Secrets nach fly (prod)“ mit `stage=true` |
| B3 | Secrets in `preview`: org-weiter `FLY_API_TOKEN` (am besten eigene fly-Org), Test-`APP_PASSWORD`, `OPENROUTER_API_KEY` | wie B2 | Workflow „Preview-App“ deploy/destroy testen (`docs/qa/R4.md`) |
| B4 | Workflows einmal ausführen | brauchen B1–B3 | Checkliste `docs/qa/R4.md` |

## Erster Prod-Deploy (R5, nach deinem QA-„go“)

| # | Was | Grund | Schritt von Nico |
|---|---|---|---|
| B5 | `dev` → `main` vorspulen | `main` = Prod-Deploy (ADR 0021), nur nach „go“ | nach den QA-Loops von R1–R4 (und folgenden) |
| B6 | Ersten Admin auf fly anlegen | `fly.toml` setzt `AUTH_MODE=users`; ohne Admin kommt niemand rein | nach dem Deploy: `fly ssh console`, dann `su node -s /bin/sh -c "node scripts/user-create.ts --email …"` (als `node`, nicht root; Weg auf echtem fly ungetestet) |
| B7 | Postfächer anlegen und „Verbindung testen“ | echte Postfächer nur Nico | Profil → Konten; vorhandene Konten-Datei wird beim ersten Start mit Schlüssel importiert (Log `legacy accounts file imported`), danach Datei und fly-Secret `ACCOUNTS_JSON` entfernen (`docs/qa/R2.md`) |
| B8 | App-Name `email-agent` frei? Preis 512 MB in `fra` prüfen | Konto/Preise nur Nico | `docs/fly-deploy.md` |

## Echtbetrieb und Scharfschalten

| # | Was | Grund | Schritt von Nico |
|---|---|---|---|
| B9 | Staging mit echtem Konto | echte Postfächer nur Nico (ADR 0042) | `docs/LOCAL_DEV_MAC.md` §2b; Erst-Import beobachten (`docs/qa/initial-import.md`) |
| B10 | Spam-Schwelle v2 (0,70) an echten Mails prüfen, bevor „Spam als gelesen“ live geht | HF-Daten haben keine harten Negative, 0,70 ist nach unten nicht abgesichert (`docs/insights.md`, ADR 0032) | in Staging Trockenlauf 2–3 Tage beobachten, dann `npm run calibrate -- --question-set email-classification-v2` auf der Staging-DB |
| B11 | Auto-Aktionen pro Konto scharf schalten | nur der Nutzer selbst (ADR 0025) | Profil → Einstellungen (R3) |
| B12 | `needs_my_reply` 0,50: zu großzügig? | Precision gegen lockere Labels ~0,5 (mehr Mails „Offen“), Geschmacksfrage | im QA-Loop entscheiden (`docs/insights.md`) |

## Datenschutz und Betrieb

| # | Was | Grund | Schritt von Nico |
|---|---|---|---|
| B13 | OpenRouter: Logging/Training aus | Konto-Einstellung | OpenRouter-Dashboard (go2market-Gate) |
| B14 | `OPENROUTER_API_KEY` in der Claude-Cloud-Umgebung | Agenten-R&D in der Cloud (ADR 0028) | Umgebungs-Secret anlegen |
| B15 | Docker-Smoke in CI | braucht Daemon; lokal grün, nicht in CI | optional: CI-Runner mit Docker |

## Mac (mac-server)

| # | Was | Grund | Schritt von Nico |
|---|---|---|---|
| B16 | Intel-Homebrew ganz entfernen | `tailscaled`, `node_exporter`, `System-One/app.py` (Intel-Python), Docker Desktop (Intel-Cask) und LaunchAgents hängen daran; sudo nötig, Tailscale-Umzug trennt SSH | lokal am Mac: `/opt/homebrew/bin/brew install tailscale`, `sudo /usr/local/bin/brew services stop tailscale`, `sudo /opt/homebrew/bin/brew services start tailscale`, dann Rest migrieren, dann Homebrew-Uninstall-Skript für `/usr/local` |
| B17 | Hermes-Dienst `ai.hermes.gateway-clemens` nutzt jetzt Node 25 statt Intel-Node 24 | Intel-`node@24` wurde entfernt | prüfen, ob er läuft; sonst arm64-`node@24` installieren und die plist anpassen |
| B18 | Rosetta bleibt | nicht sauber entfernbar; x86-Apps: AusweisApp, PDF Expert, Slack, Spectacle, TG Pro, Disk Inventory X, Spek, eDEX-UI | nur Info |

## Meilensteine mit offenem Rest

Wird beim Abschluss jedes Meilensteins ergänzt (siehe Handover).
