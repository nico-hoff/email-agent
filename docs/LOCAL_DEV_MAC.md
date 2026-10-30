# Nicos Mac: Update, lokale UI, Echtbetrieb, Live-Proben

> Für den Coding-Agenten auf dem Mac. Stand und Kontext: **`docs/HANDOVER_2026-10-30.md`**. Verbindlich bleiben `CLAUDE.md`, `AGENTS.md`, `docs/IMPLEMENTATION_PLAN.md` (Abschnitt 3), `docs/IMPLEMENTATION_PLAN_v4.md` (H11–H15) und `docs/IMPLEMENTATION_PLAN_v5.md` (H16–H22).

## 0. Harte Regeln

- Secrets nie lesen oder ausgeben: `.env*`, `.mcp.json`, Konten-Datei, `data/auth-*`, `data/*-auth-secret`. Nur Variablennamen prüfen (`grep -c '^OPENROUTER_API_KEY=' .env.local`).
- Externe Aufrufe nur, wenn Nico den jeweiligen Abschnitt beauftragt hat; Live-Proben nur mit den eingebauten synthetischen Inhalten.
- **Kein `live`-Modus** für `auto_actions` ohne Nicos ausdrückliches Okay je Konto.
- Nie `git add -A`/`.`, kein Force, kein Rebase von `main`; nichts unter `data/` committen. Pushen nur auf Nicos Anweisung.
- Mailinhalte aus `data/` nie in Chat oder Berichte kopieren.
- Weicht ein Schritt ab: anhalten, berichten.

## 1. Update

```sh
git status --short                 # erwartet leer (data/ ist ignoriert); sonst anhalten
git checkout main
git pull --ff-only
nvm use && node -v                 # exakt v26.12.1
npm ci
git worktree list                  # nur das Hauptverzeichnis erwartet
```

Liegen Worktrees unter `.claude/worktrees/` mit eigenem `node_modules`, liefert Veryfront keine Styles (Handover 10-27, Stolperstein 1). Nicht selbst löschen: Nico die Liste zeigen, je Worktree auf ungesicherte Arbeit prüfen, erst nach Freigabe `git worktree remove`. `npm run dev` warnt zusätzlich beim Start.

```sh
npm run typecheck && npm test -- --test-reporter=spec tests/*.test.ts && npm run build && npm run eval
graphify update .
```

## 2. UI lokal mit synthetischen Daten

```sh
npm run eval:fetch && npm run dev:seed     # einmalig bzw. nach Bedarf
npm run dev                                 # Startzeile: workers=disabled data=synthetic
```

http://127.0.0.1:3000 → Welcome → „Login“ (Dev-Identität). Briefing zeigt „Zusammenfassung ohne KI“, „Entwurf erzeugen“ meldet „Im Testmodus nicht verfügbar“ – beides gewollt. Klassifikationen kommen über `npm run eval:jev -- --source hf --seed 1 --n 100` (Jev-Kosten ca. 0,005 $) in die Dev-DB.

## 3. Echtbetrieb (nur auf Nicos Auftrag)

1. Konten-Datei prüfen (nur Feldnamen, keine Werte ausgeben): `label`, optional `color`, `spam_mailbox` exakt wie der Server-Ordner heißt (die Sample-Vorschau prüft Ordnernamen), `auto_actions` weglassen = `dry_run`.
2. Allowlist für den Login: Datei `auth-allowlist.json` neben der Datenbank (README, Abschnitt „Zugang über das Tailnet“; Format dort).
3. Start: `npm run dev:live` (oder Docker per `compose.yaml` für 24/7). Startzeile `workers=running`, keine `Unhandled error`.
4. Zugang: `tailscale serve --bg 3000` (nie Funnel, nie `0.0.0.0`); iPhone im Tailnet öffnet die `https://…ts.net`-Adresse, „Zum Home-Bildschirm“.
5. Trockenlauf beobachten: ⋯ → Aussortiert → Tab „Trockenlauf“. Erst nach 2–3 Tagen und Nicos Okay je Konto `"auto_actions": { "spam_seen": "live" }` setzen und Server neu starten. Not-Aus: `touch <db-ordner>/auto-actions.disabled`.

## 4. Live-Proben (je einmal, nur auf Nicos Auftrag)

```sh
npm run jev:probe:v2 -- --confirm-live
npm run eval:jev -- --question-set v2 --dataset v2 --write-dataset
npm run eval                                   # Gate muss grün bleiben; sonst Nico zeigen
npm run agent:probe -- --confirm-live
npm run briefing:probe -- --confirm-live
```

Vorher erinnern: OpenRouter-Konto auf Logging/Training prüfen (Agenten sehen Betreffs und im Entwurfsfall einen Auszug).

## 5. Kalibrierung Fragenset v2 (danach, mit Nico)

```sh
npm run eval:jev -- --source hf --split calib --question-set v2 --seed 1 --n 150 --max-cost 0.05
npm run eval:compare -- <bericht.json> --md data/eval-runs/insights-calib-v2.md
npm run calibrate                               # echte DB, inkl. Feedback-Labels
```

Ergebnisse (`insights-calib-v2.md`, Ausgabe von `calibrate`) an Nico; er gibt sie an die Cloud-Session für die Schwellen v2 (`config/noul-calibration.ts` + `docs/jev-contract.md`, beide synchron).

## 6. Bericht an Nico

`git status`/Update ok, Node-Version, Testzahlen, Startzeile, ausgeführte Abschnitte mit Ergebnis (Statuscodes, Kosten), Auffälligkeiten. Keine Inhalte aus echten Mails.
