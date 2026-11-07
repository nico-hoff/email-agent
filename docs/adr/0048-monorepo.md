# 0048 Monorepo: ein Repository, Apps und Pakete getrennt, npm-Workspaces

- Status: angenommen
- Datum: 2026-11-07
- Bezug: Vorgabe Nico 2026-11-07 („Mono-Repo ist Pflicht“, Ziel: vierstelliger MRR), ergänzt 0045 (Skalierungspfad), 0029 (Veryfront), 0047 (Browser-Tests); Supabase-Frage in 0049

## Kontext
Ziel ist ein Produkt mit vierstelligem monatlichem Umsatz. Bei 5–10 € pro Nutzer und Monat sind das grob 100–2.000 zahlende Nutzer, dazu Testnutzer. Die Architektur soll für den heutigen Stand (ein Nutzer, bald 10–50) leicht überdimensioniert sein. Das Skalieren soll dafür langweilig werden: keine Datenmigration „Einzelnutzer → Mandanten“ und kein Neuschreiben einzelner Teile, sondern Schritte nach den Schwellen aus 0045.

Heute ist alles eine Veryfront-App in einem Prozess, nämlich Seiten, API-Routen, IMAP-Worker und Agenten. Die Fachlogik liegt zu etwa 90 % frameworkfrei in `lib/`. Die Datenbank ist mandantenfähig (`user_id` auf allen Nutzertabellen, 0033), aber SQLite.

Geprüft (Probe 2026-11-07, Node 26.12.1): Ein npm-Workspace-Paket, dessen `exports` direkt auf `./src/index.ts` zeigen, lässt sich von einem anderen Workspace ohne Build importieren. Node folgt dem Symlink in `node_modules` auf den echten Pfad unter `packages/`, deshalb greift das Type-Stripping. Die Regel „Node führt `.ts` direkt aus, nur löschbare Syntax“ bleibt damit im Monorepo haltbar.

## Entscheidung
- **Ein Repository** (`nico-hoff/email-agent`) für alle Teile: Web, API, Worker, gemeinsame Pakete, Infrastruktur, Doku und Evals. Es gibt keine weiteren Repos für Teile des Produkts.
- **Zielstruktur:**

  | Pfad | Inhalt | heute |
  |---|---|---|
  | `apps/web` | Oberfläche (PWA) | Veryfront-Seiten `app/*/page.tsx` und `components/` |
  | `apps/api` | HTTP-API, Login, CSRF, Mandanten-Kontext | Veryfront-Routen `app/api/*` |
  | `apps/worker` | IMAP-Verbindungen, Klassifizieren, Agenten, Aufräumen; per ENV wählbar, welche Aufgaben eine Instanz übernimmt | im Prozess von `server.ts` |
  | `packages/core` | Fachlogik ohne Framework (Jev, Regeln, Schreibport, Push, Kalibrierung …) | `lib/` |
  | `packages/db` | Migrationen, Schema-Typen, Repository-Schicht mit erzwungenem Mandanten-Scope | `db/migrations/`, SQL in `lib/` |
  | `e2e/`, `evals/`, `docs/` | übergreifend, im Root | wie heute |
  | `compose.yaml`, `Dockerfile` | ein Image mit Targets je App, Compose für lokal und Staging | heute ein Image |

- **Abhängigkeitsrichtung:** Apps hängen von Paketen ab, nie umgekehrt. `packages/core` und `packages/db` importieren kein Web-Framework. Ein Test erzwingt das, so wie heute die Trennung `lib/` ↔ Veryfront.
- **Werkzeuge:**
  - npm-Workspaces, eine `package-lock.json`, eine Node-Version (26.12.1), ein Push-Gate über alle Workspaces.
  - Pakete exportieren ihre `.ts`-Quellen direkt (kein Build für Pakete).
  - Kein pnpm und vorerst kein Turborepo/Nx. Ein Task-Runner mit Cache kommt erst, wenn das Push-Gate dauerhaft länger als etwa 10 Minuten braucht, und bekommt dann eine eigene ADR.
- **Umbau in Schritten, jeder mit grünem Gate und ohne Verhaltensänderung:**
  1. Root wird Workspace-Root. `lib/` wird `packages/core`, das SQL wird `packages/db`. Die Veryfront-App bleibt vorerst im Root und importiert die Pakete.
  2. `apps/worker` als eigener Prozess (Schwelle ~50 Nutzer aus 0045, hier vorgezogen, sobald der Umbau ansteht).
  3. `apps/api` und `apps/web` lösen die Veryfront-App ab. Die Browser-Tests (0047) sichern dabei die Bedienung ab. Das Framework für API und Web wählt eine eigene ADR.
- Jede neue Funktion entsteht ab jetzt so, dass sie in `packages/core` passt: frameworkfrei, mandantengebunden, ohne direkten Zugriff auf `process.env` in der Fachlogik.

## Stand Schritt 1 (2026-11-07, umgesetzt)
- `lib/` → `packages/core/src/` (`@email-agent/core`), `db/migrations/` → `packages/db/migrations/` (`@email-agent/db`), Root-`package.json` mit `workspaces: ["packages/*"]`. Das Dockerfile kopiert die Workspace-Manifeste vor `npm ci`. Verhalten und alle 1.631 Tests sind unverändert, Browser-Tests 13/13.
- **Importe vorerst relativ** (`../packages/core/src/x.ts`), nicht über den Paketnamen. Probe am 2026-11-07: Veryfront schreibt reine Paketnamen in Seiten und Komponenten auf das Modul-CDN um (`https://esm.sh/@email-agent/core/…` → 404, Seite und Build scheitern). Reine Node-Apps (`apps/worker`, `apps/api`) dürfen `@email-agent/core/…` importieren; das ist mit Node 26 geprüft. Die Umstellung auf Paketnamen auch im Web folgt, wenn Veryfront nicht mehr das Frontend bündelt (Schritt 3).
- Alte ADRs, Handover und QA-Pakete nennen weiter `lib/…`. Sie sind Historie; gemeint ist jeweils `packages/core/src/…`.

## Folgen
- Schritt 1 ist reine Umstrukturierung: Pfade und Imports ändern sich, Verhalten und Tests nicht. Die Pfade in Doku, `CLAUDE.md`/`AGENTS.md`, Dockerfile, CI und graphify-Ignore werden im selben Commit angepasst.
- **Veryfront im Unterordner:** Ob Veryfront als Workspace in `apps/web` läuft (Projekt-Root, CSS-Scanner, `veryfront build`), ist nicht geprüft. Das wird vor Schritt 3 per Context7 und Probe geklärt (STOP-5 bei Widerspruch). Bis dahin bleibt die App im Root.
- **Deploy:** Mehrere Apps heißen auf fly mehrere Prozessgruppen oder Apps aus demselben Image. Lokal und im Staging beschreibt `compose.yaml` dieselben Dienste.
- 0045 bleibt gültig für die Schwellen. Welche Datenbank-Plattform den mandantenfähigen Postgres-Schritt trägt (Supabase oder reines Postgres), entscheidet 0049.
