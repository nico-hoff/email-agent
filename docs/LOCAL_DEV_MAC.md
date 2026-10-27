# Lokale Entwicklung auf Nicos Mac: Übernahme aus der Cloud-Session

> Für den Coding-Agenten auf dem Mac. Ziel: den Stand von `origin/main-3jijzg` in das lokale `main` übernehmen, die Abhängigkeiten sauber installieren und `npm run dev` lokal laufen lassen. Verbindlich bleiben `CLAUDE.md`, `AGENTS.md`, `docs/IMPLEMENTATION_PLAN.md` (Abschnitt 3, H1–H10, STOP-Punkte) und `docs/IMPLEMENTATION_PLAN_v4.md` (H11–H15).

## 0. Harte Regeln für diesen Ablauf

- Secrets nie lesen oder ausgeben: `.env`, `.env.local`, `.mcp.json`, Konten-Datei (`data/accounts.json` bzw. `ACCOUNTS_FILE`). Prüfen ist nur über Variablennamen erlaubt, z. B. `grep -c '^OPENROUTER_API_KEY=' .env.local`.
- Kein `sample`, kein `eval:jev`, keine IMAP- oder OpenRouter-Aufrufe. Die startet Nico selbst (H5/H14).
- Nie pushen, nie `git add -A`/`git add .`, kein Force, kein Rebase von `main`. Fragen an Nico statt raten.
- Bei einem Schritt, der anders ausgeht als hier beschrieben: anhalten und Nico berichten.

## 1. Ausgangslage (Stand 2026-10-27)

| Ref | Commit | Bedeutung |
|---|---|---|
| `origin/main` | `e4f1f36` | letzter gepushter Stand |
| lokales `main` auf dem Mac | `6a54bf6` | 5 Commits weiter (Notizen, Sample-Fix, Plan v4), nie gepusht |
| `origin/main-3jijzg` | `e9252f2` oder neuer | baut direkt auf `6a54bf6` auf, Fast-Forward möglich |

Inhalt von `main-3jijzg` über `6a54bf6` hinaus:
1. `19b301f` WIP-Snapshot der Desktop-App: `HANDOVER.md` (jetzt getrackt) und `node_modules/.package-lock.json`. Das sind genau die nicht committeten Änderungen, die auf dem Mac noch im Arbeitsverzeichnis liegen.
2. T29 `scripts/`: `sample.ts` und `eval-jev.ts` liegen jetzt unter `scripts/`, `tools/` ist nur noch für Veryfront-Tools.
3. T24 `npm run calibrate` (nur Aggregate aus der lokalen DB).
4. T30: `node_modules/` ist **nicht mehr getrackt**. Dazu Signal-Handler-Fix in `server.ts` und ein Status-Route-Test.
5. T39 `docs/agent-contract.md` mit offener Entscheidung O1 (siehe Abschnitt 6).
6. T40 `lib/agent-eligibility.ts`, `lib/agent-input.ts` (Sperre und Eingabe für den Antwort-Agenten).
7. T33 `lib/csrf.ts`, `lib/rate-limit.ts` (noch nicht an Routen angeschlossen, siehe `docs/DEVIATIONS.md`).
8. Fix: `calibrate` gibt im Fehlerfall nur Fehlerklasse und Code aus.
9. T41 (Teil) `tools/get-email-context.ts`, Lese-Tool für den Agenten.
10. T38 PWA: `public/manifest.webmanifest`, Icons, `public/sw.js`, `app/register-sw.tsx`, Head-Tags in `app/layout.tsx`.

## 2. Übernehmen

```sh
cd <repo>
git status --short            # erwartet: M node_modules/.package-lock.json, ?? HANDOVER.md (evtl. mehr: dann STOP)
git log --oneline -1          # erwartet: 6a54bf6 docs: approve plan v4 ...
```

Stimmt `git status` nicht mit der Erwartung überein (weitere geänderte oder neue Dateien): **anhalten** und Nico die Liste zeigen, nichts verwerfen.

Die zwei erwarteten Änderungen sind im WIP-Commit enthalten. Erst beiseitelegen, nach dem Merge vergleichen:

```sh
mkdir -p ../email-agent-backup
cp HANDOVER.md ../email-agent-backup/HANDOVER.md
mv HANDOVER.md ../email-agent-backup/HANDOVER.local.md
git restore node_modules/.package-lock.json

git fetch origin main-3jijzg
git merge --ff-only origin/main-3jijzg     # muss ohne Merge-Commit durchgehen
diff -q HANDOVER.md ../email-agent-backup/HANDOVER.local.md && echo "HANDOVER identisch"
```

Ist `HANDOVER.md` nicht identisch: Nico fragen, welche Fassung gilt. `--ff-only` scheitert: anhalten, nicht mergen oder rebasen.

## 3. Abhängigkeiten

Beim Merge löscht Git die bisher getrackten Dateien unter `node_modules/`. Das ist erwartet. Danach komplett neu installieren:

```sh
nvm use                        # liest .nvmrc
node -v                        # muss exakt v26.12.1 sein, sonst STOP-1
rm -rf node_modules
npm ci
```

`node_modules` **nicht** als Symlink anlegen: Veryfront lädt API-Routen dann mit "Import escapes the project directory" und antwortet mit 500.

## 4. Prüfen

```sh
npm run typecheck
npm test -- --test-reporter=spec tests/*.test.ts     # erwartet: 219 Tests, 0 fail (oder mehr, falls neuer)
npm run build
```

Code-Graph neu bauen (lokal, nur AST, keine API-Kosten):

```sh
graphify update .
```

## 5. Dev-Server starten

Env-Variablen nur per Name prüfen, Werte nie anzeigen:

```sh
for v in OPENROUTER_API_KEY ACCOUNTS_FILE DATABASE_PATH; do printf '%s: ' $v; grep -c "^$v=" .env.local; done
```

`npm run dev` lädt `.env.local`, falls vorhanden. Mit `ACCOUNTS_FILE` starten die IMAP-Worker gegen echte Konten (nur lesend). Für einen reinen UI-Check ohne Worker eine Wegwerf-DB nehmen und die Konten-Datei weglassen:

```sh
mkdir -m 700 -p /tmp/ea-dev && env -u ACCOUNTS_FILE DATABASE_PATH=/tmp/ea-dev/dev.sqlite node server.ts --development
```

Achtung: `node --env-file-if-exists=.env.local` (aus `npm run dev`) würde `ACCOUNTS_FILE` wieder setzen. Deshalb hier `node server.ts` direkt ohne `--env-file`.

Ob echte Worker laufen sollen, entscheidet Nico. Das wäre `npm run dev` mit seiner `.env.local`.

Checks, wenn der Server läuft:

```sh
curl -s http://127.0.0.1:3000/api/health     # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/status    # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/emails    # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/manifest.webmanifest   # 200
```

Dashboard: http://127.0.0.1:3000

## 6. Bekannte Punkte (nicht selbst „reparieren“, nur berichten)

- **Service Worker im Dev-Modus:** `public/sw.js` registriert sich auch auf `127.0.0.1` und liefert gecachte JS/CSS-Module zuerst aus (stale-while-revalidate). Nach Codeänderungen kann der erste Reload alten Code zeigen. Workaround: in den Chrome DevTools unter Application → Service Workers „Update on reload“ oder „Bypass for network“ setzen bzw. den SW abmelden. Ob die Registrierung im Dev-Modus abgeschaltet wird, ist ein offener Punkt für Nico.
- **POST gibt 403:** Veryfront lehnt im Dev-Server jeden POST ab, auch mit passender `Origin`. Heute gibt es keine eigenen POST-Routen; relevant ab T37/T42.
- **O1 offen:** Der Antwort-Agent braucht eine Provider-Entscheidung (Optionen A–D in `docs/agent-contract.md`, Abschnitt 3). Bis dahin kein `agents/reply-drafter.ts`.
- **Agent-Sperre:** Weil `interpretNoul` noch unkalibriert ist (`unmapped`), sperrt `agentEligibility` jede Mail. Das ist gewollt.
- **Commit-Autor:** Die Cloud-Commits stehen mit Autor „Claude <noreply@anthropic.com>“. Nicht umschreiben (H7).
- **`main` pushen:** Der Fast-Forward ist nur lokal. Ob und wann `main` gepusht wird, entscheidet Nico.

## 7. Nächste Schritte für Nico (nicht für den Agenten)

1. T23: Kontroll-Sample mit dem Custom-Domain-Konto, danach `npm run calibrate`.
2. T25: Schwellen aus dem Bericht festlegen.
3. T31: Tailscale-Serve-Probe im eigenen Tailnet.
4. O1: Provider-Option A–D wählen.

## 8. Bericht an Nico

Kurz: Ergebnis von `git status` vor dem Merge, Fast-Forward ok/nicht ok, `HANDOVER.md` identisch ja/nein, `node -v`, Testzahlen, Build ok, Ergebnisse der vier `curl`-Checks, Auffälligkeiten.
