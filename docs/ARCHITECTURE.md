# Architektur – E-Mail-Agent

> Stand 2026-10-31, `main` = `f7d5e73`. Diese Datei beschreibt, **wie das System gebaut ist**. Warum es so gebaut ist, steht in den ADRs (`docs/adr/`). Was gerade offen ist, steht im neuesten Handover (`docs/HANDOVER_2026-10-31.md`). Verbindliche Arbeitsregeln: `CLAUDE.md`, `AGENTS.md`, `docs/IMPLEMENTATION_PLAN.md` §3 (H1–H10), `docs/IMPLEMENTATION_PLAN_v4.md` §3 (H11–H15), `docs/IMPLEMENTATION_PLAN_v5.md` §5 (H16–H22).

## 1. Zweck und Produktbild

Ein persönlicher E-Mail-Agent für **einen Nutzer (Nico)** mit mehreren Postfächern (web.de, Custom Domain, …). Er liest alle Konten **nur lesend** per IMAP, lässt jede Mail von **Jev** (OpenRouter System One, `typesafe/jev-1.13`) klassifizieren, speichert **nur Metadaten und Urteile** in SQLite und zeigt alles in **einer** mobilen Web-App (PWA) – sortiert nach Dringlichkeit, mit Konto-Tag, Briefing beim Öffnen, Entwürfen auf Knopfdruck und optionaler Automatik („Spam als gelesen markieren“). Leitlinie: **nur Signal, wenig Rauschen**; Postfach-Schreibaktionen nur kontrolliert, rückholbar und protokolliert.

## 2. Systemüberblick

```
                ┌──────────────── Ein Node-Prozess (server.ts) ─────────────────┐
 IMAP-Konten    │                                                               │
 (web.de, …) ◄──┤ IMAP-Worker je Konto (workers/imap-worker.ts)                 │
   nur lesend   │   IDLE + Polling, Header/Flags lesen ─► Ingest (lib/ingest.ts)│
                │                                   │                           │
                │                                   ▼                           │
 OpenRouter ◄───┤ Klassifikations-Pipeline (lib/classification-pipeline.ts)     │
  Jev (System1) │   Body nur im Speicher → Jev → normalisierte Antworten        │
                │   → Shadow (lib/shadow.ts) → Absender (lib/senders.ts)        │
                │   → Regel-Engine (lib/mailbox-rules.ts) → Aktionen            │
 IMAP (Seen) ◄──┤      (lib/mailbox-actions.ts → lib/imap-write.ts, nur \Seen)  │
                │                                   │                           │
                │                         SQLite (node:sqlite, eine Datei)      │
                │                                   ▲                           │
 Browser/PWA ──►│ Veryfront startServer + requestInterceptor (Auth-Guard)       │
 (iPhone)       │   Seiten (app/*), API-Routen (app/api/*), Agenten (agents/*)  │
                │   Briefing/Entwurf → OpenRouter gpt-6-luna (über OPENAI_*)    │
                └───────────────────────────────────────────────────────────────┘
```

- **Ein Prozess**: `server.ts` startet den Veryfront-Server und die Worker im selben Prozess (`createService`). Kein zweiter Dienst, keine Queue.
- **Route-Module teilen keinen Speicher mit `server.ts`**: Veryfront bündelt Routen getrennt; sie öffnen SQLite selbst (`validateDatabasePath(process.env, PROJECT_ROOT)`).

## 3. Laufzeitmodi

| Befehl | Modus | Datenbank | Worker | Login |
|---|---|---|---|---|
| `npm run dev` | Entwicklung, **synthetisch** (`--synthetic`) | `data/dev-synthetic.sqlite` (Hugging-Face-Mails) | aus | feste Dev-Identität (= Testnutzer `dev@synthetic.invalid`, Nutzer 1), nur Loopback |
| `npm run dev:live` | Entwicklung, echt | `DATABASE_PATH` (Standard `data/email-agent.sqlite`) | an, wenn Konten-Datei existiert | Nutzerkonten (`AUTH_MODE=users`), Passwort oder Tailnet |
| `npm start` / Docker | Produktion | wie oben | wie oben | Nutzerkonten (`AUTH_MODE=users`), Passwort oder Tailnet |

Auth-Modus (`selectAuthMode`, `lib/auth.ts`): `--synthetic` → `synthetic`; `AUTH_MODE=users` → `users` (Nutzerkonten in der DB, E-Mail + Passwort, Sitzungen serverseitig widerrufbar, Registrierung nur per Einladung; ADR 0022/0033); sonst `APP_PASSWORD` gesetzt → `password` (Tailscale-Header wird ignoriert, < 16 Zeichen → niemand kommt rein); sonst `tailnet` (Header `Tailscale-User-Login` + `auth-allowlist.json`). Passwort, Tailnet und synthetisch sind Übergangsmodi und bilden für den Daten-Scope auf Nutzer 1 (den Besitzer) ab.

## 4. Komponenten

### 4.1 Einstieg und Lebenszyklus
- `server.ts`: `createService` (Startup, Bind-Adresse, Port-Auswahl, Worker, Signal-Handler, `formatListening`), `--synthetic`, Warnung bei Agent-Worktrees (`lib/dev-hazards.ts`), OpenRouter-Env (`lib/openrouter-env.ts`), Auth-Guard als `requestInterceptor`.
- `lib/users.ts` (Nutzer, Sitzungen, Einladungen, Dev-Testnutzer), `lib/user-password.ts` (scrypt-Format), `lib/tenant.ts` (Besitz-Helfer, Nutzerkontext für das Agenten-Tool), `lib/auth.ts`/`lib/auth-runtime.ts` (Cookie `v2`, Login/Registrierung/Abmelden, Guard), `lib/profile-api.ts` (Profil, Einladungen), `scripts/user-create.ts`, `scripts/user-invite.ts` (CLIs).
- `lib/accounts-config.ts` / `lib/accounts.ts`: Konten-Datei (zod, Modus 0600, absoluter Pfad oder unter `data/`), Startup, DB-Pfadprüfung (Elternordner 0700, eigener Besitzer).

### 4.2 IMAP (nur lesend)
- `lib/imap.ts`: `ImapPort` (ImapFlow-Adapter), **jedes** Postfach mit `getMailboxLock(…, { readOnly: true })`; Header, `\Seen`-Flag, gezielter Body-Abruf für die Klassifikation; Ordnerprüfung per LIST.
- `workers/imap-worker.ts`: ein Worker je Konto, IDLE auf INBOX + Polling aller beobachteten Ordner, Watchdog, Backoff, Status in `worker_status`.
- `lib/ingest.ts`: idempotentes Anlegen von `emails` und `email_locations` (UIDVALIDITY je Ordner), Ordnerwechsel als Audit.
- `lib/email-status.ts`: `\Seen` bekannter UIDs neu lesen (letzte 30 Tage, Blöcke à 200).

### 4.3 Klassifikation (Jev)
- `lib/jev.ts`: Client für `systemOneCreate` (`@openrouter/sdk`), SDK-Retries aus, eigener Backoff (`lib/retry-policy.ts`), globaler Concurrency-Limiter (`lib/limiter.ts`).
- `lib/jev-questions.ts`: versionierte Fragensets `email-classification-v1` (Standard) und `-v2` (bereit, unkalibriert); `buildState` mit Allowlist (nur strukturierter Kontext, Body/Betreff als `untrusted_*`, gekürzt auf 1 200 Zeichen).
- `lib/jev-response.ts`: Normalisierung der Antworten; `interpretNoul(answer, questionSetVersion)` über `config/noul-calibration.ts` (`lib/noul-calibration.ts` validiert). Fehlende Version/Schwelle → `unmapped`.
- `lib/classification-pipeline.ts`: Body nur im Speicher, Klassifikation persistieren (`persistNormalizedAnswers`), Shadow, `onClassified`-Hook (Absender, Regeln, Aktionen), Retry/Source-gone.
- `lib/shadow.ts`: Shadow-Quarantäne-Entscheidung (heute nie Kandidat, weil `needs_my_reply`/`is_assessable` unkalibriert; `security_auth` nie, D15).

### 4.4 Postfach-Schreiben (kontrolliert)
- `lib/mailbox-rules.ts`: reine Regel-Engine – **Schutz zuerst** (`security_auth`, `transactional`, Whitelist) → bereits gelesen → Jev-Spam → Blacklist → Provider-Spam-Ordner.
- `lib/mailbox-actions.ts`: Ausführung je Konto (`auto_actions.spam_seen`: `off|dry_run|live`, Standard `dry_run`), Not-Aus-Datei `auto-actions.disabled` neben der DB, Tageslimit 200, Idempotenz, Undo, Nachlauf beim Start.
- `lib/imap-write.ts`: **einziger** Schreibport, nur `addSeen`/`removeSeen`, eigene kurzlebige Verbindung, UIDVALIDITY-Prüfung, Rücklesen. Vertrag: `docs/imap-write-contract.md`.

### 4.5 Absender, Feedback, Kalibrierung
- `lib/senders.ts`, `lib/sender-rules.ts`, `lib/sender-hitl.ts`: Absender-Statistik, Blacklist/Whitelist (Adresse oder Domain, Freemail nie als Domain), HITL-Kandidaten nach 3 Jev-Spam-Urteilen.
- `lib/feedback.ts`: Feedback (`spam_correct`, `not_spam`, `category_wrong`, `reply_needed`, `no_reply_needed`), letzte Meinung je Thema gilt; Zähler fließen bei DMARC `pass` als Zahlen in `sender_history` des Jev-States.
- `scripts/calibrate.ts`: Schwellen-Bericht aus der echten DB (Provider-Ordner + Feedback als Label).

### 4.6 Agenten (Veryfront)
- `agents/reply-drafter.ts` (ID `replyDrafter`) und `agents/briefing.ts`: Modell `openai/openai/gpt-6-luna` (OpenRouter über abgeleitete `OPENAI_API_KEY`/`OPENAI_BASE_URL`), kein Memory, `skills: false`, `mcpServers: []`, `maxSteps` klein, Security-Middleware an. Vertrag: `docs/agent-contract.md`.
- `lib/agent-eligibility.ts` (Sperre, H11), `lib/agent-input.ts` (Eingabe-Allowlist, gezäunter Auszug), `lib/draft-reply.ts`/`lib/draft-route.ts` (Entwurf, nie gespeichert), `lib/briefing-context.ts`/`lib/briefing.ts` (nur Metadaten offener Mails, SSE-Stream, Fallback ohne KI), `tools/get-email-context.ts` (Lese-Tool, MCP aus).

### 4.7 Web-App
- Seiten: `app/welcome` (Login), `app/page.tsx` (Wichtig/Offen/Alle, Briefing, HITL-Karten), `app/emails/[id]` (Detail, Entwurf, Feedback), `app/aussortiert`, `app/absender`, `app/profil` (Konto, Sitzungen, Einladungen als Abschnitte). Komponenten in `components/`, Client-Logik in `lib/*-client.ts`, `lib/review-ui.ts`, `lib/sse.ts`. Eigenes CSS mit Tokens, Dark Mode, Safe Areas (`globals.css`). PWA: `public/manifest.webmanifest`, `public/sw.js` (cacht nur `/` und statische Dateien, nie `/api/`).
- API (alle außer Health und Auth hinter Session; POST mit Veryfront-Double-Submit **und** `x-app-csrf` + Rate-Limit):

| Route | Zweck |
|---|---|
| `GET /api/health` | Liveness (offen) |
| `GET /api/auth/session`, `POST /api/auth/login|logout|register`, `*/api/auth/deny` | Login, Modus, Registrierung (nur Users-Modus, nur mit Einladungscode), Sperr-Route |
| `GET /api/profile` | E-Mail, Rolle, aktive Sitzungen (Users-Modus) |
| `GET|POST /api/invites` | Offene Einladungen (ohne Code) / Einladung erstellen (Code einmalig), nur Admin |
| `POST /api/sessions/revoke-all` | Auf allen Geräten abmelden |
| `GET /api/status` | Worker-Status, Zähler |
| `GET /api/emails?view=important|open|noise|all&account&cursor&limit` | Liste (Dringlichkeit → Wichtigkeit → Zeit) |
| `GET /api/emails/:id` | Detail inkl. Ordnerverlauf, Aktion |
| `POST /api/emails/:id/done|undone|unread|feedback|draft` | Erledigt, Undo, Feedback, Entwurf |
| `GET|POST /api/emails/:id/feedback` | Feedback-Zustand |
| `GET /api/actions` | Trockenlauf/ausgeführte Aktionen |
| `GET /api/senders/hitl`, `POST …/hitl/dismiss`, `GET|POST /api/senders/rules`, `POST …/rules/:id/deactivate` | Absender |
| `POST /api/briefing` | SSE-Briefing |

## 5. Datenmodell

Quelle der Wahrheit: `docs/erd.md` (ERD + DDL je Migration, Schema-Test vergleicht wörtlich). Migrationen `db/migrations/001`–`006`. **Mandantenregel (ADR 0033):** `accounts`, `senders`, `sender_rules`, `user_state` tragen `user_id`; alle anderen Tabellen gehören einem Nutzer über die FK-Kette zu `accounts`, und jede Abfrage joint bis `accounts.user_id` und filtert danach (fremde ID = 404). `tests/tenant-isolation.test.ts` prüft jede Datenfunktion und Route mit zwei Nutzern.


| Tabelle | Inhalt |
|---|---|
| `users`, `user_sessions`, `invites` | Nutzer (scrypt-Hash, Rolle, Status), Sitzungen (SHA-256 des Tokens, widerrufbar), Einladungen (nur Hash des Codes) |
| `accounts` | Konto-ID, `user_id`, Label, Farbe, Host/Port/Ordner (keine Zugangsdaten) |
| `mailbox_state`, `worker_status` | UID-Checkpoint je Ordner, Worker-Zustand |
| `emails`, `email_locations` | Metadaten (Absender, Betreff, Zeit), Ort je Ordner/UIDVALIDITY |
| `classifications`, `classification_answers` | Jev-Lauf je Mail/Fragenset/Modell, normalisierte Antworten |
| `email_status` | `seen` (Provider), `done` (Nico) |
| `mailbox_actions` | geplante/ausgeführte Postfach-Aktionen (CHECKs enthalten schon M7-Werte) |
| `feedback`, `senders`, `sender_rules` | Feedback, Absender-Statistik, Black/Whitelist |
| `user_state` | z. B. `last_opened_at` (je Nutzer) |
| `audit_log` | append-only (Trigger), nur IDs/Codes/Zähler |

**Nie gespeichert:** Body, Auszug, Rohquelle, Roh-Response, Entwürfe, Briefing-Texte (H3, D17, D28). Spaltennamen werden per Test gegen `body|snippet|excerpt|raw|…` geprüft.

## 6. Sicherheitsmodell (Kurzfassung)

- **Postfach**: Lesepfad strukturell readonly; Schreibpfad nur `\Seen`, nur über `lib/imap-write.ts`, nur im Modus `live`, Schutzregeln zuerst, Undo, Not-Aus, Tageslimit.
- **Inhalte**: nie persistiert/geloggt; Logs nur IDs/Codes/Zähler (H4); synthetische Fixtures (H3).
- **Zugang**: Guard als `requestInterceptor` vor allen Routen, fail-closed auf `/api/auth/deny` (303 Seiten, 401 API, 403 fremder Tailnet-Login). Kein `middleware.ts` (Veryfront schreibt es neben die Quelle → bricht read-only Container; Test verhindert die Datei). Details: `docs/access-contract.md`.
- **Nutzerkonten (`AUTH_MODE=users`)**: Login E-Mail + Passwort (scrypt, Mindestlänge 12), Cookie `v2.<iat>.<user_id>.<token>.<mac>` (HttpOnly, SameSite=Strict, immer Secure außer Loopback); der Guard prüft MAC **und** die Sitzungszeile in der DB (Abmelden/Sperren wirkt sofort). Limits je E-Mail (Hash) und global, einheitliche 401. Registrierung nur mit Einladungscode (atomar verbraucht). Details: `docs/access-contract.md`.
- **Lokal/Tailnet**: App bindet an `127.0.0.1`; `tailscale serve --bg 3000` setzt die Identität und entfernt gefälschte Header. **Öffentlich (fly.io)**: nur mit `APP_PASSWORD` (Header ignoriert, scrypt + `timingSafeEqual`, globaler Limiter 10/15 min, Cookie immer `Secure`).
- **CSRF**: Veryfront-Double-Submit (`__Host-vf_csrf` + `x-csrf-token`) **plus** App-Token `x-app-csrf` (HMAC an Identität), Same-Origin.
- **Agenten**: Sperre im Code vor jedem Aufruf (H11), nur Metadaten fürs Briefing (H20), gezäunte nicht vertrauenswürdige Texte, keine Schreib-Tools, Text wird in der UI nie als HTML gerendert.
- **Secrets**: `.env.local`, Konten-Datei, `auth-secret`, `auth-allowlist.json`, `APP_PASSWORD` nie lesen/ausgeben/committen (H1).

## 7. Deployment

- **Docker** (`Dockerfile`, `compose.yaml`): `node:26.12.1-slim`, `USER node`, `read_only`, `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`, nur `127.0.0.1:3000` am Host, SQLite im Volume `/data`, Healthcheck `/api/health`. Prüfung: `npm run smoke:docker`.
- **fly.io** (`fly.toml`, Anleitung `docs/fly-deploy.md`): Frankfurt (`fra`), eine dauerhaft laufende Maschine `shared-cpu-1x`/512 MB (IMAP-IDLE braucht Dauerbetrieb), SQLite auf 1-GB-Volume, `internal_port = 3000`, `BIND_ADDRESS=0.0.0.0`, `AUTH_MODE=users` (oder bis zur Umstellung `APP_PASSWORD`), Start-Schutz `lib/fly-guard.ts`; Volume-Rechte über `scripts/docker-entrypoint.sh` (Target `fly`). PR #4 (fly-Vorlage) ist dadurch ersetzt.

## 8. Qualitätssicherung

| Prüfung | Befehl | Wo |
|---|---|---|
| Typecheck (TypeScript 7.0.2) | `npm run typecheck` | lokal, CI |
| Unit-/Integrationstests (`node:test`, offline) | `npm test -- --test-reporter=spec tests/*.test.ts` | lokal, CI |
| Build | `npm run build` | lokal, CI |
| Offline-Eval-Gate (Jev, Entwürfe, Briefing) | `npm run eval` | lokal, CI |
| End-to-End-Smoke (synthetisch plus Users-Modus, 40 Schritte) | `npm run smoke:e2e` | lokal, CI |
| Docker-Smoke (gehärtet) | `npm run smoke:docker` | lokal (Sandbox: Dockerfile-Kopie mit Proxy-CA) |
| Live-Evals/Proben | `eval:jev`, `eval:agents`, `jev:probe:v2`, `agent:probe`, `briefing:probe` | nur Nico, manuell |

## 9. Verzeichnis-Landkarte

`app/` Seiten und API · `agents/` Veryfront-Agenten · `tools/` Veryfront-Tools (nur `tool()`-Exporte) · `components/` React-UI · `lib/` Logik (rein, testbar) · `workers/` IMAP-Worker · `scripts/` CLIs (Sample, Evals, Smokes, Kalibrierung) · `evals/` Offline-Gates · `config/` versionierte Konfiguration (Schwellen) · `db/migrations/` Schema · `public/` PWA · `tests/` Tests und synthetische Fixtures · `docs/` Doku (Index: `docs/README.md`).
