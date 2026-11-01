# Stack-Beurteilung: Veryfront und Alternativen

> Für den E-Mail-Agenten (Stand 2026-11-01). Bezug: ADR 0001, 0003, 0029, 0045. Bewertungen von Bibliotheken spiegeln meinen Wissensstand; Versionen und Details vor jeder Entscheidung per Context7 prüfen.

## 1. Kurzfazit

| Phase | Nutzer | Empfohlener Stack | Warum |
|---|---|---|---|
| **0: jetzt** | 1–50 | **Veryfront behalten**, ein Prozess, SQLite, rohes SQL in `lib/`, eigene Tool-Schicht | Läuft, ist getestet, ein Umbau bringt funktional nichts. Kopplung an Veryfront ist klein (≈ 50 Zeilen). |
| **1: kleines Produkt** | 50–200 | Web und Worker trennen. Web: Veryfront **oder** Next.js (eigener Node-Server). Worker: eigener Node-Dienst. Datenzugriff: Repo-Schicht mit Scope-Helper | IMAP-IDLE braucht Dauerbetrieb; das Web soll unabhängig deployen und skalieren. |
| **2: Wachstum** | 200–1 000 | Next.js (oder React Router 7) fürs Web, Node-Worker, **Postgres mit Row-Level-Security**, **Kysely oder Drizzle**, Job-Queue, Vercel AI SDK für Agenten, Langfuse | Mehrere Maschinen, Mandantentrennung zusätzlich in der Datenbank, typisierte Abfragen. |
| **3: Skalierung** | 1 000–10 000+ | wie Phase 2, plus Gmail-/Graph-Push statt IDLE, OAuth, durable Workflows (Inngest, Trigger.dev, Temporal oder Restate), KMS pro Nutzer, Worker-Sharding | Provider-Limits, Compliance, Betriebssicherheit. |

**Leitlinie:** Die Fachlogik bleibt in reinen Modulen (`lib/`), Frameworks sind Hüllen. Dann kostet jeder Schritt Tage, nicht Monate.

## 2. Bewertungskriterien

1. **Laufzeitmodell:** Kann ein Prozess dauerhaft laufen (IMAP-IDLE, Timer, Worker), oder ist alles Request/Serverless?
2. **Kopplung:** Wie viel Code hängt am Framework, wie teuer ist ein Wechsel?
3. **Sicherheit:** Auth, CSRF, Mandantentrennung, Secrets, Härtung im Container.
4. **Agenten und LLM:** Tool-Gates, Streaming, Evals, Telemetrie, Modellbindung.
5. **Ökosystem:** Doku, Bibliotheken, Hosting, wie gut Coding-Agenten es kennen.
6. **Betrieb:** ein Dienst oder viele, Deploy, Kosten, Debugging.
7. **Skalierung:** horizontal, Datenbank, Queues.

## 3. Die Schichten

```
┌──────────────── Client (PWA, React) ────────────────┐
│ Seiten, Komponenten, Client-State, Service Worker   │
├──────────────── Web-Server / BFF ───────────────────┤
│ Routing, SSR, API-Routen, Auth, CSRF, Rate-Limits   │
├──────────────── Fachlogik ──────────────────────────┤
│ Regeln, Klassifikation, Postfach-Aktionen (lib/)    │
├──────────────── Agenten-Schicht ────────────────────┤
│ Agent-Loop, Tools + Gates, Prompts, Evals, Tracing  │
├──────────────── Hintergrund ────────────────────────┤
│ IMAP-Worker, Jobs, Zeitpläne, Workflows             │
├──────────────── Daten ──────────────────────────────┤
│ SQLite / Postgres, Migrationen, Zugriffsschicht     │
└─────────────────────────────────────────────────────┘
```

### Frontend / Backend / Fullstack

- **Getrennt (SPA + API):** zum Beispiel Vite + React vorn, Hono/Fastify/NestJS hinten. Klare Grenze, getrennt deploybar, zwei Projekte, CORS und Auth über zwei Origins.
- **Fullstack-Framework (Meta-Framework):** Next.js, React Router 7 (früher Remix), SvelteKit, Nuxt, Veryfront. Seiten und API in einem Projekt, SSR, eine Origin. Standard für Web-Apps dieser Größe.
- **Bei uns:** Fullstack (Veryfront) plus Worker im selben Prozess. Das ist eine Sonderform, die nur bei einem Prozess funktioniert.

### Mono-Framework vs. Baukasten

| | Mono-Framework („Batteries included“) | Baukasten („non-mono“) |
|---|---|---|
| Beispiele | Rails, Laravel, Django, Phoenix, AdonisJS, NestJS (teilweise) | Next.js + Drizzle + Better Auth + Inngest + AI SDK; Hono + Kysely |
| Vorteile | ein Weg für alles: ORM, Auth, Jobs, Mails, Admin; schnell für CRUD; stabile Konventionen | freie Wahl je Schicht, beste Bibliothek je Problem, TypeScript durchgehend |
| Nachteile | anderer Sprach-Stack (Ruby/PHP/Python/Elixir), Agenten-Ökosystem dünner als in TS/Python, starke Meinung | Integrationsarbeit, Versionspflege, mehr Entscheidungen |
| Für uns | Django wäre wegen Python-KI-Ökosystem denkbar, aber ein Komplett-Neubau. Rails/Laravel/Phoenix: technisch stark, aber Bruch mit TS. | **passt besser:** TS-Codebasis, Logik schon frameworkfrei |

**Veryfront** ist dazwischen: ein Fullstack-Framework mit eingebauten Agenten, Tools, Workflows und Evals, also für KI-Apps „batteries included“, ansonsten schmal (kein ORM, kein Auth).

## 4. Frameworks im Vergleich

| Framework | Stärken | Schwächen | Langlaufende Worker | Agenten-Fit | Passt in Phase |
|---|---|---|---|---|---|
| **Veryfront** (heute) | Seiten, Routen, Agenten, Tools, Workflows, Evals in einem; ein Prozess möglich; kleines Setup | jung (0.1.x, häufige Patches), kleines Ökosystem, Agenten kennen es kaum; erlebte Fallstricke: Root-`middleware.ts` bricht read-only-Container, CSS-Scanner, CSRF hinter Proxys nur mit Schalter, Security-Middleware nicht konfigurierbar, kein Gate vor einzelnen Tool-Aufrufen, Workflows nur Memory/Redis | ja, mit eigenem `server.ts` | gut (eingebaut), aber Gates selbst bauen (ADR 0029) | 0, ggf. 1 |
| **Next.js** | größtes Ökosystem, App Router, Server Actions, Middleware, viele Auth-Lösungen, Vercel AI SDK aus demselben Haus | Komplexität (Caching, RSC-Grenzen), Hosting-Modell auf Serverless optimiert; Worker passt nicht hinein | nur mit eigenem Node-Server; besser getrennter Worker | sehr gut (AI SDK, viele Beispiele) | 1–3 |
| **React Router 7 (Remix)** | Web-Standards (Request/Response), einfacher als Next, läuft auf jedem Node-Server | kleiner als Next.js | eigener Server möglich | gut (AI SDK funktioniert) | 1–3 |
| **SvelteKit** | schlank, schnell, sehr gute DX | anderes UI-Framework (Svelte statt React), Komponenten neu schreiben | eigener Node-Adapter | gut | Neubau, nicht für uns |
| **Nuxt (Vue)** | reif, gute DX | Vue statt React, Neuschreiben | ja | gut | Neubau, nicht für uns |
| **Hono / Fastify + Vite-SPA** | minimal, schnell, volle Kontrolle, gleicher Code für Edge und Node | SSR und Routing selbst bauen, mehr Klebecode | ja | gut (AI SDK läuft überall) | 1–2, wenn API-first |
| **NestJS** | Struktur (Module, DI, Guards, Interceptors), RBAC-Guards, Queues, große Teams | viel Boilerplate, Dekoratoren (nicht „erasable TS“), schwerfällig für kleine Teams | ja | ok | 2–3 für ein reines Backend-Team |
| **Rails / Laravel / Django / Phoenix** | Mono-Frameworks mit ORM, Auth, Jobs, Admin | Sprachwechsel; Django hätte das stärkste KI-Ökosystem (Python) | ja | Django/Python sehr gut, Rails/Laravel/Phoenix mittel | nur bei Neubau |

**Empfehlung Web-Schicht:** Phase 0 Veryfront. Beim Trennen von Web und Worker (Phase 1) Next.js oder React Router 7 prüfen. Beide nehmen die React-Komponenten fast 1:1; React Router ist näher an unserem heutigen Request/Response-Stil, Next.js hat mehr Ökosystem.

## 5. Architektur-Konzepte

### MVC und Alternativen

- **Klassisches MVC** (Rails, Laravel): Model (Daten + Regeln), View (Templates), Controller (Request → Model → View). Gut für CRUD, verführt aber zu „fetten Models“.
- **Bei uns:** eine Schichtung nach Laufzeitgrenzen: dünne Routen (Controller-Hülle) → Handler mit Auth/CSRF/Validierung (Controller) → Fachmodule mit SQL (Model + Repository gemischt) → React (View).
- **Besser ab Phase 1:** „Hexagonal light“: Fachlogik (`domain/`), Ports (Interfaces für DB, IMAP, Modelle, Push), Adapter (SQLite/Postgres, ImapFlow, OpenRouter). Der IMAP-Port und der Schreibport existieren schon so; der Datenzugriff noch nicht.
- **Feature-Ordner** (`features/accounts/{api,domain,repo,ui}`) statt Schichtordner, sobald mehrere Personen oder Agenten parallel arbeiten.

### ORM, Query-Builder, rohes SQL

| Ansatz | Beispiele | Vorteile | Nachteile | Für uns |
|---|---|---|---|---|
| Rohes SQL | heute (`node:sqlite`) | volle Kontrolle (CHECKs, Trigger, partielle Indizes), keine Abhängigkeit, Migrationen = SQL | keine Typen aus dem Schema, Mandantenfilter muss jede Abfrage selbst setzen | Phase 0 |
| Repo-Schicht ohne Lib | `lib/repo/*.ts` + zod | zentral, testbar, Scope-Helper erzwingt `user_id` | Handarbeit | Phase 0–1 |
| Query-Builder | **Kysely**, **Drizzle** | Typen aus dem Schema, SQL bleibt sichtbar, Postgres-Wechsel einfacher, Scope-Helper als Funktion | Abhängigkeit, Dialekt für `node:sqlite` prüfen | Phase 2 |
| Volles ORM | Prisma, TypeORM, MikroORM | Relationen, Migrations-Tools, schnelle CRUDs | eigene Migrationsdateien, schwächer bei SQLite-Besonderheiten, Laufzeit-Overhead, ERD-Test müsste umgebaut werden | nein |

### ACL, RBAC, ABAC, ReBAC, Mandanten

| Modell | Idee | Beispiel bei uns |
|---|---|---|
| **Mandantentrennung** (Tenancy) | jede Zeile gehört einem Nutzer/Mandanten, jede Abfrage filtert danach | heute: `accounts.user_id`, Tests (ADR 0033). Phase 2: zusätzlich Postgres-RLS |
| **ACL** (Access Control List) | pro Objekt eine Liste, wer was darf | später für geteilte Postfächer („Assistenz darf lesen“) |
| **RBAC** (Rollen) | Rollen mit Rechten, Nutzer haben Rollen | heute: `admin` / `user` (Einladungen, globaler Not-Aus) |
| **ABAC** (Attribute) | Regeln über Attribute (Plan, Region, Uhrzeit) | Premium-Modellwahl (`classifier_choice`), später Pläne |
| **ReBAC** (Beziehungen, Zanzibar-Stil) | Rechte aus Beziehungen (Team → Postfach) | erst bei Teams/Organisationen; Werkzeuge: OpenFGA, SpiceDB, Permit |

**Empfehlung:** Phase 0–1: Mandantenfilter + zwei Rollen + einzelne Berechtigungsflags (so wie jetzt). Phase 2: RLS als zweite Sicherung, eine kleine Policy-Funktion `can(user, action, resource)` an einer Stelle. ReBAC erst mit Teams.

**Auth-Bausteine:** heute selbst gebaut (scrypt, Sitzungen in der DB, Einladungen; gut getestet, aber Eigenbau). Ab Phase 2 lohnt eine Bibliothek: Better Auth (TypeScript, eigene DB, Organisationen und Rollen eingebaut) oder ein Dienst (Clerk, WorkOS, Auth0) für SSO, MFA, Passkeys. Lucia ist als Bibliothek eingestellt (nur noch Lernmaterial).

## 6. Spotlight: Agenten, LLM, Tools, Workflows

### Wann überhaupt ein Agent?

| Aufgabe | Richtiges Muster | Bei uns |
|---|---|---|
| Klassifizieren (Spam, Thema, Dringlichkeit) | **ein strukturierter Aufruf**, typisierte Antworten, Schwellen kalibriert | Jev (System One) bzw. Luna Decisions, kein Agent |
| Zusammenfassen ohne Werkzeuge | ein Aufruf mit Streaming | Briefing (heute als Agent ohne Tools, könnte ein einfacher Aufruf sein) |
| Entwurf mit Kontext | Agent mit 1–2 Lese-Tools | Reply-Drafter mit `get-email-context` |
| Mehrstufig, wartet auf Menschen oder Zeit | **Workflow** (durable), Agent nur in einzelnen Schritten | Follow-ups (R11), Freigaben |
| Offene Aufgaben mit vielen Tools | Agent mit Planung, Gedächtnis | noch nicht nötig |

**Grundsatz (ADR 0029):** Agent nur, wo das Modell entscheiden muss. Alles andere ist ein Aufruf oder Code.

### Agenten-SDKs (TypeScript zuerst)

| SDK | Stärken | Schwächen | Gate vor Tool-Aufruf | Für uns |
|---|---|---|---|---|
| **Veryfront Agents** (heute) | eingebaut, Tools per Ordner, Evals, Streaming | kein Hook vor einzelnem Tool, Freigaben nur in Cloud/Workflows, Security-Middleware fix | selbst in der Tool-Hülle (gebaut) | Phase 0 |
| **Vercel AI SDK** | Standard in TS, Provider-neutral (OpenRouter), Streaming, Tool-Calls mit Freigabe, strukturierte Ausgaben, Telemetrie | Agent-Loop bewusst einfach | ja (Freigabe/Ablehnung je Tool) | Favorit ab Phase 1 (ADR 0029) |
| **OpenAI Agents SDK** | Handoffs, Guardrails, Tracing | OpenAI-zentriert | Guardrails | wenn OpenAI-Modelle dominieren |
| **Claude Agent SDK** | sehr starker Agent-Loop (der von Claude Code), Tools, Hooks vor Tool-Aufrufen, Subagenten | auf Claude ausgerichtet, eher für „Agent macht Arbeit“-Fälle | ja (Hooks, Berechtigungen) | für komplexe Agenten, falls Claude-Modelle |
| **Mastra** | TS-Framework mit Agenten, Workflows, Memory, Evals | junger, eigenes Ökosystem | ja | Alternative zu Veryfront als „alles in einem“ |
| **LangGraph (JS/Py)** | Graphen, Checkpoints, Mensch-in-der-Schleife | Abstraktionslast, eher Python-first | ja (Interrupts) | erst bei komplexen Abläufen |
| **Strands, Pydantic AI** | schlank (AWS bzw. Python, typisiert) | Python bzw. AWS-Nähe | ja | bei Python-Backend |

### Tools richtig bauen (unabhängig vom SDK)

1. **Kern in `lib/`**: Schema + reine Funktion + typisiertes Ergebnis. Die SDK-Datei ist nur eine Hülle.
2. **Gate vor der Logik**: `allow` / `deny → { ok: false, code }` / `ask → wartet auf Freigabe in der App`. Timeout = deny.
3. **Datengrenze**: Rückgabe nur Metadaten nach Allowlist, nie ganze Mails. Nicht vertrauenswürdige Texte gezäunt (`untrusted_*`).
4. **Explizite Tool-Listen pro Agent**, nie „alle Tools“.
5. **Nutzerbindung aus dem Request** (bei uns `runAsUser`), nie aus den Modell-Argumenten.
6. **Schreib-Tools** nur hinter Freigabe und mit Undo, wie der Postfach-Schreibport.

### Workflows und Hintergrundarbeit

| Stufe | Werkzeug | Wann |
|---|---|---|
| Timer und Tabelle im Prozess | heute (Worker-Tick, `account_sync`, Push-Tick, Aufräum-Job) | Phase 0 |
| Job-Queue | Tabelle + Worker; bei Postgres pg-boss oder Graphile Worker; BullMQ (Redis) | Phase 1–2 |
| Durable Workflows | Inngest, Trigger.dev, Temporal, Restate; Veryfront-Workflows (nur Memory/Redis, eigenes SQLite-Backend möglich, ADR 0030) | Phase 2–3, wenn Abläufe über Tage laufen, auf Menschen warten und Neustarts überleben müssen |

Faustregel: Ein Workflow-System lohnt sich erst, wenn ein Ablauf mindestens zwei Wartepunkte hat (Zeit, Mensch, externes Ereignis). Follow-ups (R11) kommen mit Tabelle + Tick aus.

### Gedächtnis, RAG, Suche

- Phase 0–1: **SQLite FTS5** für Nutzer-Präferenzen (ADR 0031), keine Vektoren.
- Phase 2: Postgres mit **pgvector** oder Volltext (`tsvector`); Embeddings nur, wenn eine Eval zeigt, dass Volltext nicht reicht.
- Nie Mailinhalte als Gedächtnis speichern, nur abgeleitete Aussagen über den Nutzer.

### Evals, Telemetrie, Kosten

- **Evals:** heute Veryfront Eval (Offline-Gate mit gespeicherten Antworten) plus eigene Skripte mit Live-Proben. Bei SDK-Wechsel: promptfoo oder Braintrust; Gate-Logik in `lib/` bleibt.
- **Tracing:** Langfuse (selbst hostbar, nur Metadaten senden) oder OpenTelemetry. Ein Test sollte sicherstellen, dass kein synthetischer Mailtext in einem Span landet.
- **Kosten:** Budget pro Nutzer, Modellwahl als Premium (ADR 0041), Batch-Endpunkte für Erst-Importe (Luna `:batch` kostet die Hälfte).
- **Modellzugang:** OpenRouter als ein Schlüssel für viele Modelle; strukturierte Klassifikation über System One (Jev) oder Decisions (Luna). Für Prod: Logging/Training bei OpenRouter aus (go2market-Gate).

## 7. Skalierungsebenen im Detail

| Ebene | Engpass | Antwort |
|---|---|---|
| IMAP | ~300–1 000 IDLE-Verbindungen pro Maschine, Provider-Limits je IP | Worker-Sharding nach Konto; Gmail `watch` (Pub/Sub) und Microsoft Graph Webhooks statt IDLE |
| Klassifikation | Rate-Limits und Kosten | Queue mit Parallelitätsgrenze, Batch-Aufrufe, Budget je Nutzer |
| Datenbank | SQLite = eine Maschine | Postgres (verwaltet), RLS, Backups/PITR |
| Web | eine Instanz | mehrere Instanzen hinter dem Proxy; Sitzungen liegen schon in der DB |
| Zustand im Speicher | Rate-Limits, Push-Takte, Supervisor | in DB oder Redis verlegen |
| Secrets | ein `ACCOUNTS_ENCRYPTION_KEY` | KMS, Envelope-Verschlüsselung pro Nutzer, Rotation |
| Google/Microsoft | App-Passwörter | OAuth, Verifizierung, Sicherheits-Assessment |
| Compliance | Einzelperson | DSGVO, AV-Verträge, Lösch-/Exportfunktion, Audit |

## 8. Warum welcher Stack in welcher Phase

**Phase 0 (jetzt, Nico + Eingeladene):** Der größte Wert liegt in Produktqualität, Kalibrierung und UI. Ein Prozess mit SQLite ist am billigsten zu betreiben und zu verstehen; jede Infrastruktur-Schicht mehr kostet Zeit ohne Nutzen. Veryfront hat Macken, aber sie sind bekannt, dokumentiert und umgangen. **Nicht wechseln.**

**Phase 1 (erste zahlende Nutzer):** Der erste echte Druck ist Betriebsstabilität: Ein Web-Deploy darf die IMAP-Verbindungen nicht kappen. Deshalb Worker vom Web trennen. Das ist der natürliche Moment, die Web-Schicht neu zu wählen, weil die Hülle ohnehin angefasst wird. Next.js oder React Router 7 sind dann sinnvoll, weil Ökosystem, Auth-Bibliotheken und Agenten-Werkzeuge reifer sind; die React-Komponenten ziehen mit. Datenzugriff: Repo-Schicht mit Scope-Helper.

**Phase 2 (Wachstum):** Mehrere Maschinen erzwingen Postgres. Mit Postgres lohnt der typisierte Query-Builder und RLS als zweite Mandantengrenze. Agenten auf dem Vercel AI SDK (Gates, Telemetrie), Tracing mit Langfuse. Eine Job-Queue entkoppelt Lesen und Klassifizieren.

**Phase 3 (Skalierung):** Provider-Push statt IDLE, OAuth, durable Workflows für lange Abläufe, KMS. Ab hier ist es eher Plattform-Engineering als Feature-Arbeit.

## 9. Was wir heute schon richtig machen (und behalten)

- Fachlogik frameworkfrei in `lib/`, Hüllen dünn (ADR 0029).
- Mandantenschlüssel `user_id` von Anfang an, mit Isolationstests.
- Keine Mailinhalte in der DB, Zugangsdaten verschlüsselt.
- Klassifikation als strukturierter, kalibrierter Einzelaufruf statt Agent.
- Schreibzugriffe auf Postfächer nur über einen Port, mit Undo, Limits, Not-Aus.
- Offline-Gates (Tests, Evals, Smokes) vor jedem Push.

## 10. Entscheidungsvorschlag

1. Jetzt nichts umbauen; R10 (UI) und Staging-Erfahrung haben Vorrang.
2. ADR 0045 (Skalierungspfad) als Checkliste annehmen.
3. Beim ersten Anlass für Phase 1 eine kurze Spike-Woche: dieselbe Profilseite und eine API-Route in Next.js **und** React Router 7, Agent-Hülle auf dem Vercel AI SDK, Worker als eigener Dienst. Danach entscheiden.
