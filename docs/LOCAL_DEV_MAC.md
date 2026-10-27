# Lokale Entwicklung auf Nicos Mac: Update, UI mit Login, Eval und Agent-Probe

> Für den Coding-Agenten auf dem Mac. Ziel:
> 1. den neuesten Stand von `origin/main-3jijzg` lokal übernehmen,
> 2. die neue Mobile-UI mit Welcome-Screen und Login auf synthetischen Daten starten, damit Nico sie ansehen kann,
> 3. Eval-Läufe getrennt nach Kalibrier- und Testteil durchführen und Nico zwei Insights-Dateien zurückgeben,
> 4. genau eine Live-Probe des Antwort-Agenten machen.
>
> Verbindlich bleiben `CLAUDE.md`, `AGENTS.md`, `docs/IMPLEMENTATION_PLAN.md` (Abschnitt 3, H1–H10, STOP-Punkte) und `docs/IMPLEMENTATION_PLAN_v4.md` (H11–H15, Abschnitt 2.3).

## 0. Harte Regeln für diesen Ablauf

- Secrets nie lesen oder ausgeben: `.env`, `.env.local`, `.mcp.json`, Konten-Datei, `data/auth-*`, `data/*-auth-secret`. Prüfen nur über Variablennamen, z. B. `grep -c '^OPENROUTER_API_KEY=' .env.local`.
- Kein `npm run sample`, kein `npm run dev:live`, keine IMAP-Verbindung zu echten Konten. `npm run dev` läuft synthetisch und ohne IMAP-Worker.
- Erlaubte externe Aufrufe, alle mit synthetischen Inhalten und von Nico beauftragt:
  - Hugging Face: `npm run eval:fetch` (nur Download).
  - Jev (`typesafe/jev-1.13`): 1 Kalibrierlauf mit 150 Mails plus 3 Testläufe mit je 100 Mails, jeder Lauf mit `--max-cost 0.05`. Zusammen ca. 2,5 Cent.
  - Antwort-Agent (`openai/gpt-6-luna` über OpenRouter): genau 1 Aufruf mit `npm run agent:probe`.
- Nie pushen, nie `git add -A`/`git add .`, kein Force, kein Rebase. Nichts committen, was unter `data/` liegt.
- Mailinhalte aus `data/` nie in Chat oder Berichte kopieren. Weitergeben dürfen nur die Insights-Dateien (nur Aggregate und Fall-IDs) und die Struktur-Ausgabe der Agent-Probe (ohne Entwurfstext).
- Geht ein Schritt anders aus als beschrieben: anhalten und Nico berichten, nicht improvisieren.

## 1. Ausgangslage

Seit dem letzten Stand (`f30f4da`) neu:
- **Mobile-UI** (T36): Kartenliste mit Ansichten „Heute“, „Abweichungen“, „Alle“, Detailansicht mit Jev-Antworten, Dark Mode.
- **Welcome-Screen und Login** (T32): Ohne Session leitet `/` auf `/welcome` um, API-Routen außer `/api/health` antworten mit 401. Lokal im synthetischen Modus meldet der Knopf „Login“ die feste Dev-Identität `dev@synthetic.invalid` an. Über das Tailnet kommt die Identität aus `tailscale serve` (README, Abschnitt „Zugang über das Tailnet“, und `docs/access-contract.md`).
- **Antwort-Agent** (T41): `agents/reply-drafter.ts` auf `openai/gpt-6-luna` über OpenRouter. Der Server leitet `OPENAI_API_KEY`/`OPENAI_BASE_URL` intern aus `OPENROUTER_API_KEY` ab, nur wenn sie nicht gesetzt sind. Neue Variablen braucht es nicht.
- **Eval-Statistik**: vollständiger Download, Dubletten raus, feste Aufteilung `calib` (30 %) / `test` (70 %), geschichtete Stichprobe, Konfidenzintervalle, Precision/Recall/F1/AUC in `insights.md`. Alle Eval-Protokolle gehen in die Dev-DB, nie in die echte DB.

Details: `git log --oneline f30f4da..origin/main-3jijzg`.

## 2. Übernehmen

**Fall A, Update (der Mac steht schon auf einem früheren `main-3jijzg`-Stand, z. B. `f30f4da`):**

```sh
cd <repo>
git status --short            # erwartet: leer (data/ ist ignoriert). Sonst: anhalten, Nico die Liste zeigen.
git fetch origin main-3jijzg
git merge --ff-only origin/main-3jijzg
```

**Fall B, Erstübernahme** (lokal noch `6a54bf6`, mit `M node_modules/.package-lock.json` und `?? HANDOVER.md`): wie zuvor `HANDOVER.md` nach `../email-agent-backup/HANDOVER.local.md` verschieben, `git restore node_modules/.package-lock.json`, dann `git fetch` und `git merge --ff-only` wie oben, danach `diff -q HANDOVER.md ../email-agent-backup/HANDOVER.local.md`.

`--ff-only` scheitert: anhalten und Nico fragen.

## 3. Abhängigkeiten und alte Worktrees

```sh
nvm use && node -v            # exakt v26.12.1, sonst STOP-1
npm ci
git worktree list
ls .claude/worktrees 2>/dev/null
```

**Wichtig (Ursache für eine UI ohne Farben):** Der CSS-Scanner von Veryfront liest alle `.ts`/`.tsx`/`.js`-Dateien im Projekt und ignoriert fest nur `node_modules` im Projektwurzelverzeichnis. Liegt unter `.claude/worktrees/<name>/` ein Agent-Worktree mit eigenem `node_modules`, kommt der Scanner über 100 000 Klassen-Kandidaten und liefert **gar keine** Styles aus („CSS candidates cannot exceed 100000 candidates“ im Server-Log, rote „CSS Error“-Box auf der Seite).

Gibt es Einträge unter `.claude/worktrees/`: **nicht selbst löschen**, sondern Nico die Liste aus `git worktree list` zeigen. Für jeden Eintrag mit `git -C <pfad> status --short` und `git log --oneline main-3jijzg..<branch>` prüfen, ob dort ungesicherte Arbeit liegt. Erst nach Nicos Freigabe: `git worktree remove <pfad>`.

`node_modules` nie als Symlink anlegen; Veryfront-API-Routen antworten sonst mit 500.

## 4. Prüfen

```sh
npm run typecheck
npm test -- --test-reporter=spec tests/*.test.ts     # 0 fail erwartet
npm run build
graphify update .                                    # lokaler Code-Graph, nur AST
```

## 5. UI mit Login auf synthetischen Daten

```sh
npm run eval:fetch       # lädt beide Hugging-Face-Sets komplett (ca. 4 900 Mails) nach data/eval-datasets/
npm run dev:seed         # füllt data/dev-synthetic.sqlite, kostenlos, ohne Jev
npm run dev
```

Die Startzeile muss `workers=disabled data=synthetic` zeigen, sonst sofort stoppen und berichten. Im Server-Log darf **kein** `Unhandled error in CSS handler` stehen (siehe Abschnitt 3).

Checks in einem zweiten Terminal:

```sh
curl -s http://127.0.0.1:3000/api/health                                                   # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/status                   # 401 (ohne Login gewollt)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:3000/            # 303 .../welcome
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/welcome                      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/manifest.webmanifest         # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/_vf_styles/styles.css        # 200 (sonst Abschnitt 3)
```

Dann Nico Bescheid geben: **http://127.0.0.1:3000 öffnen** → Welcome-Screen „Angemeldet als dev@synthetic.invalid“ → „Login“ → Kartenliste. Mit dem Seed sind die Mails zunächst „Nicht bewertet“; Kategorien und Jev-Antworten erscheinen nach Abschnitt 6. Server laufen lassen.

Zeigt der Browser alten Stand: Chrome DevTools → Application → Service Workers → „Update on reload“ oder den Service Worker abmelden.

## 6. Eval-Läufe (Kalibrierung getrennt vom Test)

Voraussetzung: `OPENROUTER_API_KEY` ist in `.env.local` gesetzt (nur per Name prüfen). Kann parallel zum Dev-Server in einem dritten Terminal laufen.

Alte Laufberichte beiseitelegen, damit nichts vermischt wird:

```sh
mkdir -p data/eval-runs/old && mv data/eval-runs/*.json data/eval-runs/*.md data/eval-runs/old/ 2>/dev/null; true
```

**6a. Kalibrierteil (für die Schwellen):**

```sh
npm run eval:jev -- --source hf --split calib --seed 1 --n 150 --max-cost 0.05
mkdir -p data/eval-runs/calib && mv data/eval-runs/*-seed1.json data/eval-runs/calib/
npm run eval:compare -- data/eval-runs/calib/*.json --md data/eval-runs/insights-calib.md
```

**6b. Testteil (zur Messung, Seeds 1–3):**

```sh
npm run eval:jev -- --source hf --seed 1 --n 100 --max-cost 0.05
npm run eval:jev -- --source hf --seed 2 --n 100 --max-cost 0.05
npm run eval:jev -- --source hf --seed 3 --n 100 --max-cost 0.05
npm run eval:compare          # liest nur data/eval-runs/*.json (nicht calib/ und old/), schreibt data/eval-runs/insights.md
```

- `--split test` ist der Standard. Jeder Lauf bricht über 0,05 $ ab; erwartet sind ca. 0,005 $ pro 100 Mails.
- Jeder Lauf schreibt die Jev-Antworten zusätzlich in `data/dev-synthetic.sqlite`. Danach im Browser neu laden: Kategorien, Jev-Antworten, Shadow-Entscheidung und Abweichungen sind sichtbar.
- Fehler (`401`, `402`, `429` …): nicht wiederholen, anhalten, Fehlerklassen nennen (ohne Key oder Header).

## 7. Antwort-Agent: genau eine Live-Probe

```sh
npm run agent:probe -- --confirm-live
```

- Ein Aufruf mit einer fest eingebauten synthetischen Mail an `openai/gpt-6-luna` über OpenRouter. Gibt nur Struktur, Modell, Latenz und Tokens aus, speichert nichts.
- **Nicht** mit `--show-draft` ausführen, nicht wiederholen. Bei Fehler: Ausgabe (ohne Key) an Nico.
- Vorher erinnern: Nico prüft im OpenRouter-Konto die Einstellungen zu Logging und Training (`docs/agent-contract.md`, Abschnitt 4).

## 8. Rückgabe an Nico

1. `git status` vor dem Update, Fast-Forward ok, Liste aus `git worktree list`.
2. `node -v`, Testzahlen, Build ok.
3. UI: Startzeile, die sechs Statuscodes aus Abschnitt 5, CSS-Fehler ja/nein.
4. Eval: je Lauf `cost total`, Fehlerklassen; dann **`data/eval-runs/insights-calib.md` und `data/eval-runs/insights.md` vollständig**.
5. Agent-Probe: die Ausgabe (Struktur, Modell, Latenz, Tokens), ohne Entwurfstext.
6. Auffälligkeiten.

Nico gibt diesen Bericht an die Cloud-Session weiter.

## 9. Bekannte Punkte (nicht selbst „reparieren“, nur berichten)

- Schwellen-Datei `config/noul-calibration.ts`, Version 1 (vorläufig): `is_spam` 0.80, `is_phishing_or_scam` 0.50, `addresses_an_ai` 0.30. Die UI zeigt dafür Ja/Nein mit Rohwert und Schwelle. `needs_my_reply` und `is_assessable` bleiben „unkalibriert“, deshalb gibt es weiterhin keine Shadow-Kandidaten und keine Ansicht „Braucht Antwort“ (gewollt bis Fragenset v2). Die Werte bestätigt oder ändert Nico mit `insights-calib.md` aus Abschnitt 6a.
- Der Login-Knopf mit fester Dev-Identität funktioniert nur im synthetischen Modus. Über das Tailnet braucht es `tailscale serve` und die Allowlist `auth-allowlist.json` neben der Datenbank (README, `docs/access-contract.md`).
- Cloud-Commits haben als Autor „Claude <noreply@anthropic.com>“. Nicht umschreiben (H7).
- `main` pushen entscheidet Nico.
