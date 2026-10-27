# Lokale Entwicklung auf Nicos Mac: Übernahme, UI und Eval

> Für den Coding-Agenten auf dem Mac. Ziel:
> 1. den Stand von `origin/main-3jijzg` in das lokale `main` übernehmen,
> 2. die UI lokal starten, damit Nico sie ansehen kann,
> 3. einen Eval-Lauf auf öffentlichen synthetischen Datensets durchführen und Nico die erzeugte Datei `data/eval-runs/insights.md` zurückgeben.
>
> Verbindlich bleiben `CLAUDE.md`, `AGENTS.md`, `docs/IMPLEMENTATION_PLAN.md` (Abschnitt 3, H1–H10, STOP-Punkte) und `docs/IMPLEMENTATION_PLAN_v4.md` (H11–H15).

## 0. Harte Regeln für diesen Ablauf

- Secrets nie lesen oder ausgeben: `.env`, `.env.local`, `.mcp.json`, Konten-Datei (`data/accounts.json` bzw. `ACCOUNTS_FILE`). Prüfen nur über Variablennamen, z. B. `grep -c '^OPENROUTER_API_KEY=' .env.local`.
- Kein `npm run sample`, keine IMAP-Verbindung zu echten Konten. Die UI läuft in diesem Ablauf **ohne** IMAP-Worker (Abschnitt 5).
- Der einzige erlaubte externe Aufruf ist der Eval-Lauf aus Abschnitt 6: synthetische Mails, Modell `typesafe/jev-1.13`, höchstens 3 × 100 Aufrufe (ca. 1,5 Cent). Nico hat ihn ausdrücklich beauftragt.
- Nie pushen, nie `git add -A`/`git add .`, kein Force, kein Rebase. Nichts committen, was unter `data/` liegt.
- Mailinhalte aus `data/` nie in Chat oder Berichte kopieren. Weitergeben darf der Agent nur `data/eval-runs/insights.md` (enthält nur Aggregate und Fall-IDs).
- Geht ein Schritt anders aus als beschrieben: anhalten und Nico berichten, nicht improvisieren.

## 1. Ausgangslage

| Ref | Commit | Bedeutung |
|---|---|---|
| `origin/main` | `e4f1f36` | letzter gepushter Stand |
| lokales `main` | `6a54bf6` | 5 Commits weiter, nie gepusht |
| `origin/main-3jijzg` | neuester Stand | baut direkt auf `6a54bf6` auf (Fast-Forward) |

Wesentliche Neuerungen auf `main-3jijzg`: CLIs unter `scripts/`, `node_modules` nicht mehr getrackt, `npm run calibrate`, Agent-Sperre und -Eingabe, CSRF/Rate-Limit-Bausteine, Lese-Tool `tools/get-email-context.ts`, PWA (Manifest, Icons, Service Worker), Eval-Pipeline auf Hugging-Face-Daten (`eval:fetch`, `eval:jev --source hf`, `eval:compare` mit `insights.md`). Details: `git log --oneline 6a54bf6..origin/main-3jijzg`.

## 2. Übernehmen

```sh
cd <repo>
git status --short            # erwartet: M node_modules/.package-lock.json und ?? HANDOVER.md, sonst nichts
git log --oneline -1          # erwartet: 6a54bf6 docs: approve plan v4 ...
```

Weitere geänderte oder neue Dateien: **anhalten**, Nico die Liste zeigen, nichts verwerfen.

Beide erwarteten Änderungen stecken im WIP-Commit `19b301f`. Beiseitelegen, übernehmen, vergleichen:

```sh
mkdir -p ../email-agent-backup
mv HANDOVER.md ../email-agent-backup/HANDOVER.local.md
git restore node_modules/.package-lock.json

git fetch origin main-3jijzg
git merge --ff-only origin/main-3jijzg
diff -q HANDOVER.md ../email-agent-backup/HANDOVER.local.md && echo "HANDOVER identisch"
```

`--ff-only` scheitert oder `HANDOVER.md` weicht ab: anhalten und Nico fragen.

## 3. Abhängigkeiten

Beim Merge löscht Git die bisher getrackten Dateien unter `node_modules/`. Das ist erwartet.

```sh
nvm use                        # liest .nvmrc
node -v                        # exakt v26.12.1, sonst STOP-1
rm -rf node_modules
npm ci
```

`node_modules` nie als Symlink anlegen; Veryfront-API-Routen antworten sonst mit 500 („Import escapes the project directory“).

## 4. Prüfen

```sh
npm run typecheck
npm test -- --test-reporter=spec tests/*.test.ts     # 0 fail erwartet
npm run build
graphify update .                                    # lokaler Code-Graph, nur AST
```

## 5. UI starten (ohne IMAP-Worker)

Env-Variablen nur per Name prüfen:

```sh
for v in OPENROUTER_API_KEY ACCOUNTS_FILE DATABASE_PATH; do printf '%s: ' $v; grep -c "^$v=" .env.local; done
```

Die lokale Datenbank (`DATABASE_PATH`, Standard `data/email-agent.sqlite`) enthält die Mails aus Nicos erstem Sample. Die UI zeigt sie, ohne dass IMAP-Worker laufen. Die Worker starten nur, wenn die Konten-Datei existiert. Deshalb zeigt `ACCOUNTS_FILE` für diesen Start auf einen nicht existierenden Pfad. Bereits gesetzte Variablen haben Vorrang vor `.env.local`, `DATABASE_PATH` kommt weiter aus `.env.local`:

```sh
ACCOUNTS_FILE=/nonexistent/accounts.json npm run dev
```

Die Startzeile muss `workers=disabled` zeigen. Steht dort `workers=running`: sofort mit Ctrl-C stoppen und Nico berichten.

Checks in einem zweiten Terminal:

```sh
curl -s http://127.0.0.1:3000/api/health                                          # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/status          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/emails          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/manifest.webmanifest   # 200
curl -s http://127.0.0.1:3000/api/status | python3 -c 'import json,sys; print(json.load(sys.stdin)["classifications"])'   # nur Zähler
```

`/api/emails` liefert Absender und Betreff echter Mails: den Inhalt nicht ausgeben oder kopieren, nur den Statuscode prüfen.

Dann Nico Bescheid geben: **UI unter http://127.0.0.1:3000 im Browser öffnen.** Den Server laufen lassen, bis Nico fertig ist.

Hinweis Service Worker: `public/sw.js` registriert sich auch lokal und liefert gecachte JS/CSS zuerst aus. Zeigt die Seite nach Codeänderungen alten Stand: Chrome DevTools → Application → Service Workers → „Update on reload“ aktivieren oder den SW abmelden.

## 6. Eval-Lauf (öffentliche synthetische Datensets)

Voraussetzung: `OPENROUTER_API_KEY` ist in `.env.local` gesetzt (nur per Name prüfen, siehe oben). Kann parallel zum laufenden Dev-Server in einem weiteren Terminal laufen.

```sh
npm run eval:fetch                                        # lädt 2 synthetische Sets nach data/eval-datasets/ (kein Jev-Aufruf)
npm run eval:jev -- --source hf --seed 1 --n 100 --max-cost 0.05
npm run eval:jev -- --source hf --seed 2 --n 100 --max-cost 0.05
npm run eval:jev -- --source hf --seed 3 --n 100 --max-cost 0.05
npm run eval:compare                                      # schreibt data/eval-runs/insights.md
```

- Jeder `eval:jev`-Lauf macht höchstens 100 Aufrufe (harte Grenze 200) und bricht über 0,05 $ ab. Erwartet sind ca. 0,005 $ pro Lauf.
- Endet ein Lauf mit Fehlern (z. B. `401`, `402`, `429`): nicht wiederholen, anhalten und Nico die Fehlerklassen aus der Ausgabe nennen (ohne Key oder Header).
- Laufberichte liegen unter `data/eval-runs/*.json`, nichts davon committen.
- Datenquellen, Lizenzen und Label-Mapping: `docs/eval-datasets.md`.

## 7. Rückgabe an Nico

Ein kurzer Bericht plus der vollständige Inhalt von `data/eval-runs/insights.md`:

1. `git status` vor dem Merge, Fast-Forward ok/nicht ok, `HANDOVER.md` identisch ja/nein.
2. `node -v`, Testzahlen, Build ok.
3. UI: Startzeile mit `workers=…`, die vier Statuscodes, Klassifikationszähler aus `/api/status`.
4. Eval: je Lauf die Zeilen `cost total` und `cost per mail`, Fehlerklassen, dann **`data/eval-runs/insights.md` vollständig als Markdown** (die Datei enthält nur Aggregate und Fall-IDs und darf weitergegeben werden).
5. Auffälligkeiten.

Nico gibt diesen Bericht an die Cloud-Session weiter.

## 8. Bekannte Punkte (nicht selbst „reparieren“, nur berichten)

- POST-Anfragen gibt Veryfront im Dev-Server mit 403 zurück. Heute gibt es keine eigenen POST-Routen; relevant ab T37/T42.
- O1 offen: Provider für den Antwort-Agenten (Optionen A–D in `docs/agent-contract.md`, Abschnitt 3).
- `interpretNoul` ist unkalibriert (`unmapped`), daher sind Shadow-Entscheidung und Agent-Sperre fail-closed. Das ist gewollt.
- Cloud-Commits haben als Autor „Claude <noreply@anthropic.com>“. Nicht umschreiben (H7).
- `main` pushen entscheidet Nico.
