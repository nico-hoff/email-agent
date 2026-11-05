# 0047 Browser-Tests mit Playwright (UI-TDD, Teil des Push-Gates)

- Status: angenommen
- Datum: 2026-11-05
- Bezug: Wunsch Nico 2026-11-05 („Playwright für TDD unserer UI“), ergänzt 0019 (Push-Gate), Plan v5 T44 (`smoke:e2e`), H1/H3/H6 (nur synthetische Daten)

## Kontext
Bisher prüfen die Tests die UI nur als reine Funktionen (`tests/*-ui.test.ts`) und den Dienst nur per HTTP (`npm run smoke:e2e`). Ob die Seiten im Browser hydrieren, Klicks bei React ankommen und Mutationen mit Cookies und CSRF-Headern durchgehen, prüfte nichts automatisch. Für die anstehende UI/UX-Iteration fehlt damit ein Sicherheitsnetz. Doku über Context7 (`/microsoft/playwright`, 2026-11-05): `defineConfig`, `webServer`, `projects` mit `devices`, Setup-Projekt mit `storageState`.

## Entscheidung
- `@playwright/test` 1.64.1, exakt gepinnt, als devDependency. Specs liegen unter `e2e/*.spec.ts` (nicht in `tests/`, damit `node --test` sie nicht aufnimmt). Konfiguration in `playwright.config.ts`, Aufruf mit `npm run e2e:browser`.
- Der Server ist `scripts/e2e-browser-serve.ts`: der echte Dienst im Nutzer-Modus, Production-Modus (nach `npm run build`) auf `127.0.0.1:3300`, mit einer frischen Temp-Datenbank und dem synthetischen QA-Satz aus `scripts/qa-serve.ts` (simulierte Antworten). Es gibt keine Worker, keine Konten-Datei, keine Env-Datei, keinen API-Schlüssel und keinen Modell- oder IMAP-Aufruf. Die Temp-Datenbank wird beim Beenden gelöscht. `E2E_SERVER_MODE=development` erlaubt die TDD-Schleife ohne Build.
- Abgedeckt sind vier Kern-Flows: Anmeldung (Weiterleitung, falsches und richtiges Passwort), Liste (Ansichten, Erledigt und Rückgängig), Detail (erledigen, wieder öffnen, zurück) und Profil (Menü, Abmelden). Jeder Flow läuft in zwei Projekten: Desktop-Chromium und iPhone-15-Viewport auf Chromium.
- Locators richten sich nach Rolle und Name (`getByRole`, `getByLabel`), nicht nach CSS. So übersteht ein Redesign die Tests, solange die Bedienung gleich bleibt. Screenshot-Vergleiche gibt es vorerst nicht; sie würden jede Designänderung brechen.
- Die Tests nutzen eine Datenbank für alle, daher läuft ein Worker. Tests stellen her, was sie ändern. Das Setup-Projekt meldet sich einmal an, speichert die Sitzung und wärmt alle Seiten vor. Der Production-Server kompiliert jede Seite beim ersten Aufruf: kalt dauert das etwa 25–60 s, danach etwa 2 s.
- Das Push-Gate wird um `npm run e2e:browser` nach `smoke:e2e` erweitert. Die CI installiert Chromium (`npx playwright install --with-deps chromium`) und führt die Tests aus.

## Folgen
- **`127.0.0.1` statt `localhost`:** Veryfront behandelt den Host `localhost` als eigene lokale Domain und beantwortet `/` im Production-Modus mit seiner Projektübersicht statt der App.
- **Veralteter Modul-Cache:** Der lokale Production-Modul-Cache (`.cache/veryfront-mdx-esm/email-agent/preview-main`) lieferte am 2026-11-05 ein Modul ohne einen neueren Export, sodass `/aussortiert` mit 500 antwortete. Deshalb leert der Test-Server diesen Cache vor jedem Production-Start. Der Dev-Server nutzt einen anderen Cache. In Docker und auf fly ist der Cache immer frisch.
- **Kein echtes WebKit:** Echtes WebKit speichert die `__Host-`/`Secure`-Cookies der App auf `http://127.0.0.1` nicht, deshalb scheitern dort Anmeldung und CSRF. Das iPhone-Projekt prüft vorerst Viewport, Touch und User-Agent auf Chromium. Echtes Safari/WebKit braucht einen HTTPS-Testserver; das ist ein Folgeschritt.
- **Laufzeit:** Das Gate wird etwa 2 Minuten länger, davon geht rund 1 Minute aufs Vorwärmen.
- **Datenschutz:** Traces und Screenshots von Fehlschlägen liegen in `test-results/` (gitignored) und enthalten nur synthetische Daten.
- **Netzzugriff:** Die Seiten laden React aus dem Veryfront-CDN, die Tests brauchen also Netz (lokal und in CI vorhanden).
