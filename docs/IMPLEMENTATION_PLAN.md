# Implementierungsplan v3 – E-Mail-Agent (80/20, Jev im Shadow-Modus)

> **Quelle der Wahrheit:** dieses Dokument und `docs/erd.md`. Überholt und nur noch Historie: `.hermes/plans/2026-10-26_194916-email-agent-80-20.md` und `HANDOVER.md` (beides ist hier eingearbeitet; bei Widerspruch gilt dieses Dokument). Der Blueprint `docs/E-Mail-Agent – Blueprint (Veryfront, Jev, Raspberry Pi).md` ist Hintergrund; seine Phasen 4–8 sind **nicht** Teil dieses Plans.

## 1. Ziel

Ein Veryfront-Prozess beobachtet konfigurierbare IMAP-Konten (pro Konto ein unabhängiger Worker mit IDLE, Poll-Fallback und Watchdog), lässt Jev (OpenRouter System One) neue bzw. manuell ausgewählte Mails über einen versionierten Fragensatz klassifizieren und zeigt lokal nur Metadaten, Jev-Antworten und deterministische **Shadow-Entscheidungen** an. Nico prüft die Ergebnisse am Freigabepunkt (Abschnitt 7); erst danach darf irgendetwas an einem Postfach verändert werden.

**Nicht-Ziele (nicht bauen, auch nicht „vorbereitend“):** jede Mailbox-Schreibaktion (Verschieben, Löschen, Flags, Entwürfe, Senden), Quarantäne/Löschung, Telegram, GPT-6-Luna-Agent, Raspberry-Pi-/systemd-Deployment, Authentifizierung oder Netzwerk-Exposition, Gmail-OAuth, Second-Brain-Anbindung, echte Mails in Tests/Fixtures/CI.

## 2. Festgelegte Entscheidungen

| ID | Entscheidung |
|---|---|
| D1 | Node exakt `26.12.1`, npm mit `package-lock.json`. Kein pnpm/yarn/bun (das `pnpm`-Feld in `package.json` ist Starter-Überrest, ignorieren). |
| D2 | Veryfront `0.1.1285` für Web/API. Eigener Entrypoint `server.ts` mit `startServer` aus `veryfront/server`; Webserver und Worker laufen im selben Prozess. |
| D3 | Jev nur über `@openrouter/sdk`: `OpenRouterCore` + `systemOneCreate`. Modell als Codekonstante `typesafe/jev-1.13`. Kein Chat-Agent, kein Modell-Fallback, keine Modell-Env, kein `jev-latest`. |
| D4 | Eine Pflicht-Variable: `OPENROUTER_API_KEY`. Zwei optionale Overrides mit In-Repo-Defaults: `ACCOUNTS_FILE` (Default `data/accounts.json`) und `DATABASE_PATH` (Default `data/email-agent.sqlite`), aufgelöst relativ zur Projektwurzel (Verzeichnis von `server.ts`), nicht zum Arbeitsverzeichnis. Das Elternverzeichnis der DB wird beim Start mit Modus `0700` angelegt. Zusätzlich die rein operative `BIND_ADDRESS` (Default `127.0.0.1`, im Container `0.0.0.0`). Alles andere sind Konstanten in `lib/constants.ts` (`DEFAULT_ACCOUNTS_FILE`, `DEFAULT_DATABASE_PATH` inklusive). |
| D5 | Zugangsdaten stehen ausschließlich in einer JSON-Datei (`ACCOUNTS_FILE`). Liegt sie im Repo, dann nur unter dem per `.gitignore` ausgeschlossenen Ordner `data/`; außerhalb des Repos ist ebenfalls erlaubt (z. B. im Container unter `/run/secrets`). |
| D6 | SQLite über `node:sqlite`, Schema exakt nach `docs/erd.md`. |
| D7 | Body-Auszug maximal 1200 Zeichen, nur im Arbeitsspeicher, nur als `untrusted_body` an Jev. |
| D8 | Live-Worker: IDLE nur auf `mailbox`; Poll alle 5 Minuten auf `mailbox` **und** `spam_mailbox`. Im Spam-Ordner werden live nur Header (Message-ID) bekannter Mails ausgewertet, um Provider-Verschiebungen zu erkennen. Neue, unbekannte Mails im Spam-Ordner werden live **nicht** klassifiziert; das passiert nur im manuellen `sample`. |
| D9 | Shadow-Modus: keine Aktion. Die Routing-Antwort (`route`) wird nur gespeichert, `shadow_quarantine` nur berechnet. |
| D10 | Jev-Aufrufe laufen über einen Limiter mit einem gleichzeitigen Request **pro Prozess**. Server und CLI (`sample`/`eval`) sind getrennte Prozesse, es sind also bis zu zwei Requests gleichzeitig möglich; 429-Backoff fängt das ab. |
| D11 | `security_auth`-Policy ist offen. Bis Nico sie nach dem Sample festlegt, lautet jede positive Shadow-Entscheidung `pending_policy`. |
| D12 | Docker Compose bindet den Host-Port nur an `127.0.0.1`. |

Konstanten (`lib/constants.ts`): `EXCERPT_MAX_CHARS = 1200`, `POLL_INTERVAL_MS = 300_000`, `WATCHDOG_STALE_MS = 720_000`, IMAP-Backoff 1 s bis 300 s mit Jitter, Jev-Retry-Backoff 30 s bis 900 s, `JEV_MAX_ATTEMPTS = 8`, Scheduler-Tick 15 s, Sample-Hartlimit 400, `JEV_MODEL = "typesafe/jev-1.13"`, `QUESTION_SET_VERSION = "email-classification-v1"`.

### Konfiguration: Pflicht und optional

| Variable | Status | Default | Zweck |
|---|---|---|---|
| `OPENROUTER_API_KEY` | **Pflicht** | – | Key für Jev über OpenRouter System One. Nur in `.env.local` bzw. Container-Umgebung, nie im Repo. |
| `ACCOUNTS_FILE` | optional | `data/accounts.json` | JSON mit den IMAP-Zugangsdaten. Im Repo nur unter `data/`, Modus `0600`, reguläre Datei. Fehlt sie, startet nur die UI (Workerstatus `disabled`). |
| `DATABASE_PATH` | optional | `data/email-agent.sqlite` | SQLite-Datei. Das Elternverzeichnis wird beim Start mit Modus `0700` angelegt. |
| `BIND_ADDRESS` | optional | `127.0.0.1` | Bind-Adresse des Webservers; im Container `0.0.0.0` (per Compose). |

Relative Pfade werden gegen die Projektwurzel aufgelöst (Verzeichnis von `server.ts`), nicht gegen das Arbeitsverzeichnis. Es gibt keine weiteren Variablen: kein `OPENAI_*`, kein Modell-Alias, keine Schwellwert- oder Intervall-Variablen (das sind Konstanten bzw. stehen in der Konten-Datei). Die Vorlage ist `.env.example` im Repo-Root.

## 3. Arbeitsregeln für den Implementierer

### 3.1 Lesereihenfolge
`AGENTS.md` → `docs/erd.md` → dieses Dokument vollständig. Lege danach eine Task-Liste für P und T1–T22 an.

### 3.2 Standard-Zyklus (gilt für jeden Task, wenn nicht anders vermerkt)
1. **RED:** Verhaltenstest zuerst schreiben und mit dem *erwarteten* Grund fehlschlagen sehen: `npm test -- --test-reporter=spec tests/<datei>.test.ts`.
2. **GREEN:** minimal implementieren, derselbe Befehl mit `fail 0`, Exitcode 0.
3. **REFACTOR**, dann `npm run typecheck` und `npm test -- --test-reporter=spec tests/*.test.ts`, beide Exitcode 0.
4. `git status --short` prüfen, dann **nur die im Task genannten Dateien** committen. Dauert ein Task über 5 Minuten, vorher in Mikroschritte mit je einem Verhalten aufteilen.

Tests laufen offline mit `node:test`, temporären SQLite-Dateien (in `os.tmpdir()`) und injizierten Fakes für IMAP und SDK.

### 3.3 Harte Regeln
- **H1 Secrets:** Inhalte von `.env`, `.env.local`, `.mcp.json` und `ACCOUNTS_FILE` nie lesen, ausgeben oder committen (Existenz/Variablennamen prüfen ist erlaubt, z. B. `grep -c '^OPENROUTER_API_KEY=' .env.local`). Der Code liest sie nur zur Laufzeit.
- **H2 Keine Mailbox-Schreibaktion:** Der IMAP-Port (`ImapPort`-Interface) hat keine Schreibmethoden; Postfächer werden nur schreibgeschützt geöffnet (laut ImapFlow-Doku `getMailboxLock(path, { readOnly: true })` – gegen Context7 `/postalsys/imapflow` verifizieren). Ein Test belegt es mit einem Fake, dessen Schreibmethoden werfen.
- **H3 Keine Inhalte persistieren:** Weder Body, Auszug, Rohquelle noch Roh-Response gelangen in SQLite, Logs, API, Dashboard, Fixtures oder CI-Artefakte. Fixtures sind ausschließlich synthetisch.
- **H4 Logs** enthalten nur `trace_id`, `account_id`, UID, Fehlercodes und Zähler. Nie Betreff, Absender, Body, Hostnamen, Usernamen oder Credentials.
- **H5 Externe Aufrufe:** Du rufst nur die ausdrücklich benannten Jev-Proben (T3, T12) und genau einen Lauf von `eval:jev` (T18) aus, jeweils mit **synthetischen** Inhalten und `typesafe/jev-1.13`. Nie IMAP gegen echte Konten, nie `sample` gegen echte Konten – das macht Nico am Freigabepunkt.
- **H6 Vertrag statt Annahme:** Keine erfundenen SDK-/Response-Felder, Skalen oder RetryConfig-Syntax. Reihenfolge der Wahrheit: Context7 (`/openrouterteam/typescript-sdk`, `/postalsys/imapflow`, `/websites/veryfront`) → installierte Typdeklarationen → echte synthetische Fixtures. Ist Context7 nicht erreichbar, gelten Typdeklarationen und Fixtures. Bei Widerspruch: STOP-5.
- **H7 Git:** Nie `git add -A`/`git add .`, nie pushen, nie force/amend auf bereits Committetes. Nicht committen: `.env*`, Accounts-Datei, SQLite-Dateien, Maildaten.
- **H8 Scope:** Nichts aus den Nicht-Zielen bauen. Neue Abhängigkeiten nur: `zod`, `imapflow`, `mailparser` (+ `@types/mailparser`, falls nötig), `@openrouter/sdk`.
- **H9 Node-Code:** Von Node direkt ausgeführter Code (`server.ts`, `lib/`, `workers/`, `tools/`) importiert relativ **mit `.ts`-Endung** und nutzt nur löschbare TypeScript-Syntax (keine `enum`, `namespace`, Parameter-Properties). JSX nur unter `app/`.
- **H10 Fassen nicht an:** `.hermes/`, `HANDOVER.md`, den Blueprint und `docs/erd.md` (Änderungen am Schema nur per dokumentierter Abweichung, siehe 3.5).

### 3.4 STOP-Punkte (kurz melden und warten, nicht raten)
- **STOP-1:** Preflight scheitert (Node-Version, ungeplante Working-Tree-Änderungen, fehlende Env-Variablennamen).
- **STOP-2:** `startServer` bedient die App-Routen nicht korrekt oder lässt keinen Worker-Lifecycle zu. Kein zweiter Prozess als Ausweg.
- **STOP-3:** Minimal- oder Vollprobe schlägt fehl (401/402/sonstiger Fehler) oder die Antwort enthält nicht, was spätere Tasks brauchen. Berichte die beobachtete Form (ohne Credentials).
- **STOP-4:** Docker-Tag `node:26.12.1-slim` fehlt oder hat kein `linux/arm64`. Nie still auf eine andere Version wechseln.
- **STOP-5:** Dokumentation, installierte Typen und Fixtures widersprechen sich.
- **STOP-6:** Ein Task bräuchte eine nicht aufgeführte Abhängigkeit, Env-Variable oder Schemaänderung.
- **STOP-7:** Freigabepunkt (Abschnitt 7).

### 3.5 Abweichungen und Bericht
Jede bewusste Abweichung vom Plan wird in `docs/DEVIATIONS.md` festgehalten (Datum, Task, Grund, Auswirkung) und mit dem betroffenen Task committet. Der Abschlussbericht am Freigabepunkt enthält: Task-Status, Commit-Liste (Hash und Message), Testzahlen, Abweichungen, offene Fragen.

## 4. Jev/OpenRouter: verifizierter Stand und Lücken

Aus der OpenRouter-Doku (`docs/client-sdks/typescript/sdks/systemone`):

```ts
import { OpenRouterCore } from "@openrouter/sdk/core.js";
import { systemOneCreate } from "@openrouter/sdk/funcs/systemOneCreate.js";

const openRouter = new OpenRouterCore({ apiKey: process.env["OPENROUTER_API_KEY"] ?? "", appTitle: "email-agent" });

const res = await systemOneCreate(openRouter, {
  decisionsRequest: {
    model: "typesafe/jev-1.13",
    questions: {
      is_bug: {
        type: "noul",
        instructions: "Is the customer reporting a software defect?",
        criteria: { false: "…", true: "…" },
      },
      team: {
        type: "choice",
        instructions: "Which team should own this ticket?",
        criteria: { account: "…", frontend: "…", payments: "…" },
      },
      urgency: {
        type: "score",
        instructions: "How urgent is this ticket?",
        criteria: ["Can wait for the next release", "Should be fixed this week", "Blocking revenue right now"],
      },
    },
    state: { customer_tier: "enterprise", ticket: "…" },
  },
});
if (res.ok) { /* res.value is the DecisionsResponse */ } else { /* res.error */ }
```

- Fragetypen heißen `noul`, `choice`, `score`. `noul`-Kriterien: `{ false, true }`; `choice`-Kriterien: Objekt Schlüssel → Beschreibung; `score`-Kriterien: geordnetes Array von Ankerbeschreibungen. `state` ist ein Objekt Schlüssel → Wert. Mehrere Fragen gehören in **einen** Request.
- Fehler laut Doku: 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529 (plus allgemeine 4XX/5XX).
- Bare Modell-IDs (`jev-1.13`) werden auf den `typesafe/`-Namespace gemappt; wir verwenden immer die volle ID.
- Laut Drittquelle gilt ein State-Budget von 32.000 Token; 1200 Zeichen Auszug liegen weit darunter.

**Nicht verifiziert (nur per Probe klärbar):** Struktur von `DecisionsResponse` (`answers`, `model`, `usage` sind in früheren Notizen genannt), ob pro Frage Wahrscheinlichkeiten geliefert werden, die numerische Skala und Entscheidungsschwelle von `noul`, der Wertebereich von `score`, die genaue Deaktivierung der SDK-Retries. Alles davon wird in T3/T12 beobachtet und in `docs/jev-contract.md` festgehalten, bevor Code davon abhängt.

## 5. Fragenset `email-classification-v1`

Alle Fragen in **einem** Request. Instruktionen und Kriterien auf Englisch (die Mails sind deutsch/englisch gemischt). Die endgültigen Formulierungen schreibt der Implementierer in `lib/jev-questions.ts` nach den in T3 beobachteten Formen; Inhalt und Keys sind verbindlich:

| Key | Typ | Bedeutung |
|---|---|---|
| `is_spam` | noul | Unerwünschte Massen-/Werbemail, Junk, den der Empfänger nie angefordert hat. |
| `is_phishing_or_scam` | noul | Täuscht Zugangsdaten, Zahlung oder Klick vor (falsche Bank-/Paket-/Kontomails, Rechnungsbetrug, Identitätsvortäuschung). Bewusst getrennt von Spam. |
| `addresses_an_ai` | noul | Text richtet sich an einen KI-Assistenten/Agenten oder enthält Anweisungen an ihn (Injection-Indikator). Ein Treffer bedeutet später: Mail nie an einen LLM-Agenten. |
| `needs_my_reply` | noul | Vom Empfänger wird Antwort oder Handlung erwartet (Frage, Bitte, Frist, Termin). |
| `is_assessable` | noul | Genug lesbarer Inhalt für ein verlässliches Urteil (nicht leer, abgeschnitten, unlesbar, fremdsprachig). |
| `category` | choice | `spam`, `newsletter_promo`, `transactional`, `security_auth` (Login-Codes, Passwort-Resets, Sicherheitswarnungen), `personal`, `business`, `unclear`. |
| `route` | choice | `ignore`, `digest`, `notify`, `draft_reply`. Im MVP nur gespeicherter Vorschlag, nie eine Aktion. |
| `urgency` | score | Anker aufsteigend: „kein Termin, kann warten“ / „diese Woche“ / „innerhalb 48 Stunden“ / „heute oder blockierend“. |
| `importance` | score | Anker aufsteigend: „Routine“ / „nützlich, nicht kritisch“ / „erhebliche persönliche, finanzielle oder rechtliche Folge“ / „kritisch für Sicherheit, Gesundheit oder Recht“. |

**State (Allowlist, strukturiert):** `account_context`, `sender_domain`, `spf`, `dkim`, `dmarc`, `list_unsubscribe_present`, `reply_to_differs_from_from`, `sender_history` (nur aggregierte Zähler aus der DB, z. B. `mails_seen_from_sender`, `days_since_first_seen`), `untrusted_subject`, `untrusted_body`. Keine vollständigen Header, keine Mailhistorie mit Inhalt. Skala und Form der Werte richten sich nach SDK-Typen/Fixture, nicht nach einer geratenen 0–1-Annahme.

## 6. Tasks

Commit-Message-Präfix: `phase N: …` bzw. `chore: …`. Jeder Task listet Test, Implementierung und Commit; der Standard-Zyklus aus 3.2 gilt zusätzlich.

### Preflight P (kein Code)
Nur lesend, nie Werte ausgeben:
1. `node -p 'process.version'` muss `v26.12.1` sein, `node -p 'process.features.typescript'` muss `strip` sein.
2. `git status --short`: erlaubt sind nur die Übergabedateien (`AGENTS.md`, `CLAUDE.md`, `.env.example`, `HANDOVER.md`, `docs/…`, `.hermes/…`). Committe zuerst genau diese: `git add AGENTS.md CLAUDE.md .env.example docs/IMPLEMENTATION_PLAN.md docs/erd.md docs/KICKOFF_PROMPT.md && git commit -m "docs: add implementation plan v3 and ERD"`. Weitere ungeplante Änderungen → STOP-1.
3. `.env.local` existiert und enthält den Variablennamen `OPENROUTER_API_KEY` (nur Zählung per `grep -c`). `ACCOUNTS_FILE` und `DATABASE_PATH` sind optional. Fehlt der Key → STOP-1.
4. `docker manifest inspect node:26.12.1-slim`: `linux/arm64` und `linux/amd64` vorhanden? Fehlt der Tag, jetzt nur melden und bis T21 weiterarbeiten; vor T21 → STOP-4.
5. Nico bestätigt im Startprompt: OpenRouter-Key und Guthaben für `typesafe/jev-1.13` vorhanden, die Proben T3/T12 mit synthetischen Daten sind autorisiert.

### Phase 0 – Laufzeit, Prozessgrenze, Fail-fast-Probe

**T1 – Node-Pin und Test-Runner.** Dateien: `.nvmrc` (`26.12.1`), `package.json` (`engines.node` exakt `26.12.1`, `scripts.test = "node --test"`), optional `tsconfig.json` (`erasableSyntaxOnly: true`, nur wenn `npm run typecheck` grün bleibt; sonst H9 per Review durchsetzen). Kein Behavior-Test; der Runner wird mit dem RED-Test aus T2 erstmals geprüft. Commit: `chore: pin Node 26 runtime and test runner` (`.nvmrc package.json package-lock.json` und ggf. `tsconfig.json`).

**T2 – Entrypoint und Health.** Vorher Context7 `/websites/veryfront` (`veryfront/server`) lesen und mit `node_modules/veryfront/esm/src/server/index.d.ts` abgleichen.
- Test `tests/server.test.ts`: exportierte Factory `createService({ port: 0, bindAddress, workers: false })` startet, `GET /api/health` liefert exakt `{"status":"ok"}`, `stop()` gibt den Port frei; `resolveBindAddress(undefined)` ist `127.0.0.1`, mit Override der Override.
- Implementierung: `server.ts` mit `startServer`, Standardport 3000, Modus aus Startargument `--development|--production`, Start nur bei `import.meta.main`; `app/api/health/route.ts`. Scripts: `dev` = `node --env-file-if-exists=.env.local server.ts --development`, `start` = `node --env-file-if-exists=.env.local server.ts --production` (Node lädt `.env.local` nicht von selbst; Veryfront-Laden nicht voraussetzen).
- Smoke: `npm run dev`, separat `curl -fsS http://127.0.0.1:3000/api/health`, Ctrl-C beendet sauber. Bedient `startServer` die Routen nicht → STOP-2.
- Commit: `phase 0: verify Veryfront process entrypoint` (`package.json package-lock.json server.ts app/api/health/route.ts tests/server.test.ts`).

**T3 – Fail-fast-Minimalprobe und Vertragsdokument.** `npm install @openrouter/sdk`. Lies Context7 `/openrouterteam/typescript-sdk` (System One, `DecisionsResponse`, Questions/Answers, `RetryConfig`) und die installierten Typen. Schreibe `tools/jev-contract-probe.ts` mit einem Minimalset (je ein `noul`, `choice` mit zwei Optionen, `score`) und einer **synthetischen** Mail (offensichtlich erfundener Text). Genau **ein** Aufruf: `node --env-file=.env.local tools/jev-contract-probe.ts`. Der Runner schreibt nur die echte synthetische Antwort nach `tests/fixtures/jev-minimal-response.json` und gibt keine Credentials aus. Danach Probe-Datei löschen. Fehlt Key oder Guthaben, schlägt der Aufruf fehl oder fehlt, was spätere Tasks brauchen: STOP-3.
- Dokumentiere die Beobachtungen in `docs/jev-contract.md` (kurz): Antwortform je Typ, ob Wahrscheinlichkeiten vorhanden sind, Skala/Schwelle von `noul`, Bereich von `score`, Felder `model`/`usage`, wie SDK-Retries abschaltbar sind.
- Commit: `phase 0: capture Jev minimal response contract` (`package.json package-lock.json tests/fixtures/jev-minimal-response.json docs/jev-contract.md`).

### Phase 1 – Konten-Datei und DB

**T4 – Konten-Datei validieren und schützen.** `npm install zod`.
- Test `tests/accounts-config.test.ts` mit temporären Dateien: gültiges Array; falscher Port, fehlendes Passwort, leerer Host, fehlende Felder, doppelte `id`, Pfad im Repo, relativer Pfad, Symlink und Dateimodus mit `mode & 0o077 !== 0` werden abgelehnt („Pfad im Repo“ heißt: im Repo, aber nicht unter `data/`). Der Default-Pfad `data/accounts.json` wird gefunden, wenn `ACCOUNTS_FILE` nicht gesetzt ist; fehlt die Datei, startet nur die UI mit Workerstatus `disabled`. Fehlermeldungen nennen Feldnamen, nie Werte.
- Implementierung `lib/accounts-config.ts`: Der aufgelöste Pfad muss eine reguläre Datei (kein Symlink) sein, nur für den Besitzer lesbar (`mode & 0o077 === 0`), und liegt er unter der Projektwurzel, dann nur unter `data/` (rein pfadbasiert, ohne Git zur Laufzeit – im Container gibt es kein `.git`). Felder je Konto: `id`, `label`, `context` (kurzer Konto-Prior für Jev), `host`, `port`, `tls`, `user`, `password`, `mailbox`, `spam_mailbox` (optional), `spam_threshold` (0–1, Default 0.95), `enabled`. Mehrere aktivierte Konten werden unterstützt; lokal ist zunächst genau eines aktiv.
- Dazu `docs/accounts.example.json` (nur Platzhalter, drei Beispielkonten mit verschiedenen `context`-Texten, z. B. „Private inbox with much bulk mail; provider spam filter is unreliable“ und „Custom-domain mailbox; almost only important mail“). `.env.example` existiert bereits und wird im Preflight committet; nur anpassen, falls sich Variablen ändern. Prüfe, dass `.gitignore` `.env`, `.env.local`, `data/` und `*.sqlite*` abdeckt; ergänze fehlendes. Ein Test belegt per `git check-ignore -q data/accounts.json data/email-agent.sqlite`, dass beide Default-Pfade ignoriert sind. Prüfe zusätzlich per Context7 (`/websites/veryfront`), ob Veryfront eine eigene Ignore-Datei für Deploy/Upload kennt (Nico nennt sie `.vfignore`, der Name ist unverifiziert). Falls ja, trage dort `data/` und `.env*` ein; falls nein, vermerke das in `docs/DEVIATIONS.md` und verwende `npm run deploy` (`veryfront deploy`) in diesem Projekt nicht.
- Commit: `phase 1: validate protected multi-account config` (`package.json package-lock.json lib/accounts-config.ts tests/accounts-config.test.ts docs/accounts.example.json .gitignore`).

**T5 – Schema und Migrationen.** Dateien: `db/migrations/001_init.sql` (DDL **wörtlich** aus `docs/erd.md`), `lib/db.ts` (`openDatabase(path)` setzt auf jeder Verbindung `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`; Migrationsrunner wie in `docs/erd.md` beschrieben).
- Test `tests/db.test.ts`: alles unter „Schema-Test“ in `docs/erd.md`, plus Migrationen laufen idempotent und numerisch sortiert.
- Commit: `phase 1: add versioned metadata schema` (`db/migrations/001_init.sql lib/db.ts tests/db.test.ts`).

**T6 – Kontometadaten in die DB und Startvalidierung.**
- Test `tests/account-db.test.ts`: je aktiviertem Konto Upsert in `accounts` (id, label, host, port, mailbox, spam_mailbox, enabled); Konten, die in der Datei fehlen, werden `enabled = 0` gesetzt, nie gelöscht; `worker_status` bekommt je Konto eine Zeile (`disabled` bzw. `connecting`); Passwort und `spam_threshold` tauchen weder in SQL noch in Logs/Fehlern auf.
- Implementierung `lib/accounts.ts`; Startsequenz: Datenbankpfad validieren → Migrationen → Konten initialisieren.
- Commit: `phase 1: add safe account metadata bootstrap` (`lib/accounts.ts tests/account-db.test.ts`).

### Phase 2 – IMAP

**T7 – IMAP-Port und Metadaten-/Auszug-Extraktion.** `npm install imapflow mailparser` (+ `@types/mailparser` falls nötig). Context7 `/postalsys/imapflow` zu UIDVALIDITY, Mailbox-Locks (`readOnly`), IDLE und Timeouts lesen.
- Test `tests/imap.test.ts` mit Fake-Client und synthetischer MIME-Mail: nur Leseoperationen werden aufgerufen (Schreibmethoden des Fakes werfen); Message-ID, Absenderadresse (klein geschrieben), Betreff (inkl. kodierter Wörter), Datum, `spf`/`dkim`/`dmarc` (aus `Authentication-Results`, Werte `pass|fail|softfail|neutral|none|temperror|permerror|unknown`), `list_unsubscribe_present`, `reply_to_differs_from_from`; Body-Auszug wird hart auf `EXCERPT_MAX_CHARS` gekürzt; Grundlage ist `parsed.text`, HTML und Anhänge werden nie weitergegeben; die DB-Schreibfunktion erhält nur Metadaten, nie den Auszug.
- Implementierung `lib/imap.ts`: `ImapPort`-Interface (`connect`, `mailboxStatus`, `fetchHeadersSince`, `fetchMessageByUid`, Events, `close`) und ImapFlow-Adapter. Erster Kontakt je `(Konto, Ordner)` ohne `mailbox_state`: Baseline = höchste vorhandene UID, nichts importieren. UIDVALIDITY-Wechsel: Baseline neu setzen, bisherige Locations dieses Ordners `is_active = 0`, Audit `uidvalidity_reset`.
- Commit: `phase 2: read IMAP metadata safely` (`package.json package-lock.json lib/imap.ts tests/imap.test.ts`).

**T8 – Idempotente Aufnahme (Mail + Location).**
- Test `tests/ingest.test.ts`: neue Mail erzeugt `emails` + `email_locations`; dieselbe Location nochmals ist idempotent; gleiche Message-ID in neuem Ordner (Provider-Verschiebung INBOX → Spam) fügt Location hinzu, setzt die alte auf `is_active = 0` und schreibt Audit `folder_changed {from, to}` ohne Constraint-Fehler; Mail ohne Message-ID wird über die Location dedupliziert; Mail anderen Kontos mit gleicher Message-ID kollidiert nicht.
- Implementierung `lib/ingest.ts` (eine Transaktion pro Mail, Rückgabe `{ emailId, isNew }`).
- Commit: `phase 2: ingest mail locations idempotently` (`lib/ingest.ts tests/ingest.test.ts`).

**T9 – IDLE-Worker je Konto mit Poll-Fallback und Watchdog.**
- Test `tests/imap-worker.test.ts` (Fake-Ports, injizierte Uhr): zwei aktivierte Konten haben je einen eigenen Client/Lifecycle; Fehler oder Backoff von Konto A blockiert Konto B nicht; Events je Konto laufen seriell; IDLE-Event löst sofortigen Sync aus; Poll alle `POLL_INTERVAL_MS` auf `mailbox` und `spam_mailbox` holt UIDs über dem Checkpoint (Spam-Ordner nur Header, nur Abgleich bekannter Message-IDs, siehe D8); Watchdog erzwingt Reconnect nur des betroffenen Kontos, wenn `last_ok_at` älter als `WATCHDOG_STALE_MS` ist, wobei erfolgreiche Polls `last_ok_at` aktualisieren (**ein ruhiges Postfach löst keinen Reconnect aus**); Reconnect mit begrenztem Backoff und Jitter; IMAP-Login-Fehler setzen den Worker auf `paused` mit Code `imap_auth` und werden nicht wiederholt; `stop()` schließt jeden Client; Zustand wird nach `worker_status` geschrieben (`connecting|connected|backoff|paused`, `last_event_at`, `last_poll_at`, Fehlercode ohne Details).
- Implementierung `workers/imap-worker.ts` mit Callback `onIngested(emailId, transientInput)` (Verdrahtung in T16). Kein Mailbox-Schreibaufruf.
- Commit: `phase 2: isolate resilient IDLE workers per account` (`workers/imap-worker.ts tests/imap-worker.test.ts`).

**T10 – Lifecycle und `/api/status`.**
- Test `tests/service-lifecycle.test.ts` (injizierte Factories): ohne `ACCOUNTS_FILE` startet nur die UI, Workerstatus `disabled`; ungültige Datei oder Rechte führen zu klarem Startfehler ohne Secrets; Start startet Server und Worker genau einmal; SIGINT/SIGTERM beenden alle Worker und den Server und loggen genau einmal `shutdown complete`; ein Workerfehler beendet den Prozess nicht. Test `tests/status-route.test.ts`: `GET /api/status` liefert je Konto `account_id`, `state`, `last_event_at`, `last_poll_at`, `error_code` und aggregierte Klassifikationszähler nach Status, ohne Hostnamen, User, Betreff, Body oder Secrets.
- Implementierung: `server.ts` verdrahtet Worker; `app/api/status/route.ts` liest **ausschließlich aus SQLite** (Veryfront lädt Routen eventuell in eigenem Modulkontext; Singletons aus `server.ts` sind dort nicht sichtbar). `/api/health` bleibt reine Prozess-Liveness.
- Commit: `phase 2: run isolated workers in-process with status route` (`server.ts workers/imap-worker.ts app/api/status/route.ts tests/service-lifecycle.test.ts tests/status-route.test.ts`).

### Phase 3 – Jev

**T11 – Fragenset und State-Definition.**
- Test `tests/jev-questions.test.ts`: alle Keys und Typen aus Abschnitt 5, Kategorien und Routen vollständig, Anker in aufsteigender Reihenfolge, `QUESTION_SET_VERSION = "email-classification-v1"`, State-Allowlist (jeder andere Key wird abgelehnt; `untrusted_*` sind die einzigen Freitextfelder; `buildState()` kürzt auf `EXCERPT_MAX_CHARS`).
- Implementierung `lib/jev-questions.ts` nach den in T3 beobachteten, SDK-typisierten Formen.
- Commit: `phase 3: define versioned Jev email questions` (`lib/jev-questions.ts tests/jev-questions.test.ts`).

**T12 – Voll-Probe: zweites Fixture.** Genau **ein** Aufruf mit dem vollständigen Set aus T11 und einer synthetischen Mail über eine temporäre `tools/jev-contract-probe.ts` (danach wieder löschen), Ausgabe nach `tests/fixtures/jev-email-v1-response.json`. Ergänze `docs/jev-contract.md` um alles, was erst das volle Set zeigt (z. B. Wahrscheinlichkeiten je Choice-Option). Fehler → STOP-3. Commit: `phase 3: capture full-set Jev response` (`tests/fixtures/jev-email-v1-response.json docs/jev-contract.md`).

**T13 – Antwort-Normalisierung.**
- Test `tests/jev-response.test.ts` gegen **beide** Fixtures: bekannte Antworten werden typisiert gelesen; fehlende, zusätzliche oder falsch typisierte Antworten werden gezielt abgelehnt; keine Felder (`spamProbability`, `confidence`, `reason`) werden angenommen, die Fixture/Typen nicht liefern.
- Implementierung `lib/jev-response.ts`: normalisiert in `{ key, type, value, probabilities? }`. Dazu `interpretNoul(answer)` mit Ergebnis `positive | negative | unmapped` strikt nach `docs/jev-contract.md`; ist keine eindeutige Regel belegt, ist das Ergebnis `unmapped` (fail-closed).
- Commit: `phase 3: normalize Jev answers from real fixtures` (`lib/jev-response.ts tests/jev-response.test.ts`).

**T14 – System-One-Client und Limiter.**
- Test `tests/jev.test.ts` mit injiziertem `systemOneCreate`: Request enthält `questions` und `state`, Modell ist `typesafe/jev-1.13`; Erfolg liefert die SDK-Antwort unverändert; `res.ok === false` wird nie als leerer Erfolg behandelt, der Statuscode wird aus dem SDK-Fehler gelesen, unerwartete Transportfehler werden abgefangen; der Limiter lässt höchstens einen Aufruf gleichzeitig laufen.
- Implementierung `lib/jev.ts` (`OpenRouterCore` + `systemOneCreate`, `appTitle: "email-agent"`) und `lib/limiter.ts`. Keine Veryfront-Agentdatei für Jev.
- Commit: `phase 3: call Jev through OpenRouter System One` (`lib/jev.ts lib/limiter.ts tests/jev.test.ts`).

**T15 – Fehlerklassen, genau eine Retry-Ebene, Scheduler.** Vorher Context7 und installierte `RetryConfig`-Typen prüfen, wie SDK-Retries vollständig deaktiviert werden (laut `docs/jev-contract.md`). Keine selbst ausgedachte Syntax. Lassen sich SDK-Retries nicht abschalten, ist die SDK die einzige Retry-Ebene und es gibt keinen zweiten Backoff.
- Test `tests/retry-policy.test.ts` mit injiziertem `statusCode`: 429/500/502/503/524/529 → `retry_wait`, `attempts + 1`, `next_attempt_at` (Backoff 30 s bis 900 s); nach `JEV_MAX_ATTEMPTS` → `failed` mit `failure_code = max_attempts`; 400/403/413 → `failed`; 401/402 → Zeile `paused` plus Audit `jev_paused`, weitere Aufrufe stoppen bis manuellen Neustart; Start des Prozesses setzt `paused` zurück auf `pending`; nicht klassifizierte Transportfehler gelten nur nach expliziter Testregel als transient. Scheduler: beim Start werden fällige Zeilen geladen (`pending`, sowie `retry_wait` mit `next_attempt_at <= now`), ein Timer (Tick 15 s) holt später fällige nach; die erste Verarbeitung nutzt den Auszug aus dem Arbeitsspeicher, **jeder Retry holt den Body per aktiver Location neu aus IMAP**; existiert keine aktive Location oder UID mehr → `failed` mit `source_gone` und Audit `source_gone`.
- Implementierung `lib/retry-policy.ts`, Scheduler in `lib/classification-pipeline.ts`.
- Commit: `phase 3: classify Jev failures without retry storms` (`lib/retry-policy.ts lib/classification-pipeline.ts tests/retry-policy.test.ts`).

**T16 – Pipeline, Antworten und Shadow-Regel.**
- Test `tests/classification-pipeline.test.ts`: je neuer Mail genau eine Zeile `classifications` (idempotent über `(email_id, question_set_version, model_requested)`); Mail-Metadaten werden vor dem Jev-Aufruf gespeichert; Antworten landen in `classification_answers` zusammen mit `model_reported` und `latency_ms` in einer Transaktion; neues Fragenset erzeugt eine neue Version ohne bestehende Zeilen zu überschreiben; weder Auszug noch Roh-Response noch ungeprüfte SDK-Objekte erreichen SQLite oder Logs; **kein** Mailbox-Write wird aufgerufen.
- Shadow-Regel (`lib/shadow.ts`, reine Funktion): `candidate = interpretNoul(is_spam) positive UND Spam-Wert >= spam_threshold des Kontos UND interpretNoul(needs_my_reply) negative UND interpretNoul(is_assessable) positive`. Ist ein Teil `unmapped`, ist `candidate = false` mit `reason = unmapped_answer` (keine willkürlichen Grenzwerte). `category`/`security_auth` fließt **nicht** als Entscheidung ein, sondern wird roh als Eingabe festgehalten (D11). Gespeichert als abgeleitete Antwort `question_key = "shadow_quarantine"`, `type = "derived"`, `answer_json = { candidate, decision: "pending_policy" | "no", applied_threshold, inputs, reason }`, dazu Audit `shadow_quarantine_computed`. Auch bei `candidate = true` ändert sich nichts am Postfach.
- Verdrahtung: `workers/imap-worker.ts` ruft über `onIngested` die Pipeline auf (Auszug nur im Arbeitsspeicher, gecachte Einträge werden nach dem ersten Versuch verworfen).
- Commit: `phase 3: persist Jev answers and shadow rules` (`lib/classification-pipeline.ts lib/shadow.ts workers/imap-worker.ts tests/classification-pipeline.test.ts`).

**T17 – Manuelles Sample.**
- Test `tests/sample.test.ts` (Fake-IMAP und Fake-Jev): Standardlauf ist **Vorschau**: gibt je Ordner die Anzahl der ausgewählten Mails (letzte N je `mailbox` und `spam_mailbox`) und die Gesamtzahl aus, ohne einen Jev-Aufruf; Ausführung verlangt `--confirm <exakte-Vorschauzahl>`, bei Abweichung Abbruch; Hartlimit 400; bereits klassifizierte Mails (gleiches Konto/Mail/Fragenset) werden übersprungen; `--question-set <version>` wertet denselben Bestand bewusst neu aus (Body wird per aktiver Location neu geholt); der Ordner der aktiven Location dient als Vergleichslabel (Provider-Urteil); Fortschritt wird nur aggregiert ausgegeben; keine Flags, keine Moves; Audit `sample_previewed`, `sample_started`, `sample_finished`.
- Implementierung `tools/sample.ts` und Script `sample` (`node --env-file=.env.local tools/sample.ts`): `npm run sample -- --account <id> --limit-per-folder 200` (Vorschau) bzw. `… --confirm <N>`. **Du führst sie nicht gegen echte Konten aus (H5).**
- Commit: `phase 3: add confirmed read-only sample` (`tools/sample.ts package.json package-lock.json tests/sample.test.ts`).

**T18 – Eval-Set und `eval:jev`.** Prüfe vorher Context7 `/websites/veryfront` und die installierte Version zum `veryfront/eval`-Vertrag. Gibt es keinen unterstützten Adapter für eine normale SDK-Funktion, lasse `npm run eval` unverändert und tarne Jev nicht als Chat-Agent; ergänze den expliziten Runner `eval:jev`.
- Daten: `tests/fixtures/eval/email-eval-v1.jsonl` mit rund 30 **synthetischen**, deutsch/englisch gemischten Beispielen und erwarteten Labels: `security_auth` (4), Phishing/Scam (4), Prompt-Injection-Texte (4), Newsletter (4), transaktional (4), Spam (4), persönlich (3), geschäftlich (3), dazu ein bis zwei nicht beurteilbare Fälle.
- Test `tests/eval-runner.test.ts` (Fake-Jev): lädt das Set, berechnet je Frage die Trefferquote, gibt nur aggregierte Zahlen aus.
- Implementierung `tools/eval-jev.ts` und Script `eval:jev` (`node --env-file=.env.local tools/eval-jev.ts --confirm-live`), nicht in CI. Führe **genau einen** Lauf gegen den echten Endpunkt aus (≤ 30 synthetische Aufrufe) und trage die aggregierten Ergebnisse in den Abschlussbericht ein; Audit `eval_run`.
- Commit: `phase 3: add synthetic Jev eval set and runner` (`tests/fixtures/eval/email-eval-v1.jsonl tools/eval-jev.ts package.json tests/eval-runner.test.ts`).

**T19 – Lese-API und Review-Dashboard.**
- Test `tests/email-route.test.ts` gegen synthetische DB-Zeilen: `GET /api/emails` (nur GET, Filter nach Konto/Status, höchstens 200 Zeilen, chronologisch absteigend) liefert Metadaten, aktive Location/Ordner, versionierte Antworten, `shadow_quarantine` und **Abweichungen** (Provider sagt Spam, weil aktive Location im `spam_mailbox` liegt, versus Jev; sowie umgekehrt). Die Antwort enthält nie Body, Auszug, Rohheader, SDK-Rohantwort oder Secrets; ein Marker-Test prüft das.
- Implementierung: `app/api/emails/route.ts` (liest nur aus SQLite) und `app/page.tsx` als minimale Übersicht (Konto, Ordner, Kategorie, Antworten, Shadow-Entscheidung, Abweichungen, Workerstatus aus `/api/status`). Keine Schreibbuttons. Die Interpretation nutzt `lib/shadow.ts`/`interpretNoul`; ist sie `unmapped`, zeigt die UI den Rohwert. Prüfe, dass `npm run build` `node:sqlite` in Routen korrekt auflöst.
- Manuell: `npm run dev`, `curl -fsS http://127.0.0.1:3000/api/emails` zeigt synthetische Metadaten ohne Inhaltsfelder, der Browser dieselben Daten.
- Commit: `phase 3: review Jev answers and provider disagreements` (`app/api/emails/route.ts app/page.tsx tests/email-route.test.ts`).

**T20 – Starter-Altlasten entfernen, README.** Erst wenn T19 grün ist: ein Test belegt, dass `GET /api/emails`, `/api/status` und `/api/health` verfügbar sind. Dann `git rm` von `agents/researcher.ts`, `agents/writer.ts`, `tools/publish.ts`, `workflows/content-pipeline.ts`, `lib/workflows.ts`, `app/api/workflows/[...path]/route.ts`, `app/workflows/[id]/page.tsx`. `README.md` neu: lokale Einrichtung (`.env.local`, Konten-Datei mit `chmod 600`, `npm run dev`), Beobachtungsmodus, Datenschutz, `sample`/`eval:jev`, fehlende Produktionsfreigabe. Validierung: `npm run typecheck`, alle Tests, `npm run build`, jeweils Exitcode 0; `git status --short` zeigt nur Erwartetes. Commit: `phase 3: classify mailboxes in observe-only mode` (`README.md` und die entfernten Dateien, jeweils explizit).

### Phase 4 – Container und CI

**T21 – Docker und Compose.** Vorher STOP-4 prüfen. Test (klein) für `BIND_ADDRESS`-Auflösung (falls nicht schon durch T2 abgedeckt). Dateien: `Dockerfile` (`FROM node:26.12.1-slim`, `npm ci`, `npm run build`, `USER node`, `/data` mit Besitzer `node:node`, `CMD ["npm","start"]`), `.dockerignore` (mindestens `.git`, `.hermes`, `node_modules`, `.env*`, `data`, `docs/accounts*.json`), `compose.yaml`:
```yaml
services:
  email-agent:
    build: .
    restart: unless-stopped
    environment:
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:?Set OPENROUTER_API_KEY}
      ACCOUNTS_FILE: /run/secrets/accounts.json
      DATABASE_PATH: /data/email-agent.sqlite
      BIND_ADDRESS: 0.0.0.0
    volumes:
      - ${ACCOUNTS_FILE:-./data/accounts.json}:/run/secrets/accounts.json:ro
      - email-data:/data
    ports:
      - "127.0.0.1:3000:3000"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  email-data:
```
Ein Worker im Zustand `paused`/`backoff` darf **keinen** Container-Restart auslösen; der Healthcheck prüft nur, ob die Status-Route HTTP-ok antwortet. Schreibt Veryfront zur Laufzeit in ein Verzeichnis (z. B. `.veryfront/`), dafür gezielt `tmpfs` oder Volume mounten, nicht `read_only` aufgeben. Keine Konten-Datei oder Secrets ins Image/Repo.
- Smoke (mit temporärer Konten-Datei: `mktemp`, `chmod 600`, ein Konto `enabled: false`, Dummy-Werte, außerhalb des Repos): `docker compose --env-file .env.local config --quiet`, `build`, `up -d`, `curl -fsS http://127.0.0.1:3000/api/health` → `{"status":"ok"}`, Healthcheck `healthy`, `down`. Scheitert nur der Dateimodus-Check am Docker-Dateisystem (Besitzer/UID), schwäche ihn **nicht**: melde es und dokumentiere in `README.md`, dass auf Linux `chown 1000:1000` plus `chmod 600` nötig ist.
- Commit: `phase 4: containerize the local observer` (`Dockerfile compose.yaml .dockerignore README.md` und ggf. Test).

**T22 – CI, Dependabot, Pin-Test.** `.github/workflows/ci.yml` (`node-version-file: .nvmrc`; `npm ci`, `npm run typecheck`, `npm test -- --test-reporter=spec tests/*.test.ts`, `npm run build`; keine Secrets, keine IMAP-/Jev-Tests, kein Deploy), `.github/dependabot.yml` (wöchentlich für `npm`, `docker`, `github-actions`), Test `tests/pins.test.ts`: `.nvmrc`, `engines.node` und die Dockerfile-`FROM`-Version müssen identisch sein, ein Teilupdate scheitert. Validierung: YAML-Struktur prüfen und dieselben vier Befehle lokal ausführen. Commit: `phase 4: pin Node across CI, Docker and engines` (`.github/workflows/ci.yml .github/dependabot.yml tests/pins.test.ts`).

## 7. Freigabepunkt – danach zwingend stoppen (STOP-7)

Vollautomatisiert vorab: `npm run typecheck`, gesamte Offline-Suite, `npm run build`, Docker-Health-Smoke und `git status --short` (keine `.env*`, Konten-Datei, SQLite-Datei oder Maildaten im Commit). Dann **Bericht an Nico** (Format aus 3.5, plus aggregierte `eval:jev`-Ergebnisse, Inhalt von `docs/jev-contract.md` in drei Sätzen, offene Fragen) und warten. Nicht mehr tun.

Was danach **Nico** manuell macht (du nicht):
1. `data/accounts.json` anlegen (Vorlage `docs/accounts.example.json`, `chmod 600`), echten Spam-Ordnernamen per IMAP-LIST eintragen, zuerst genau ein Testkonto aktivieren (das web.de-Konto mit viel Spam), als Kontrolle später die Custom-Domain (dort sollte `shadow_quarantine` fast nie `pending_policy` ergeben).
2. Datenweitergabe bestätigen: bis zu 400 gekürzte Auszüge samt Absender/Betreff gehen an OpenRouter.
3. `npm run sample -- --account <id> --limit-per-folder 200` (Vorschau), dann mit `--confirm <N>`.
4. Dashboard prüfen: Jev gegen Provider-Ordner, `security_auth`, Phishing, Injection-Indikator, `needs_my_reply`, Assessability, Importance/Urgency, Modell/Latenz, `shadow_quarantine`. Daraus entscheidet Nico die `security_auth`-Policy (D11) und die Schwellwerte.

Ohne ausdrückliche Freigabe: keine Quarantäne, kein Löschen, kein Markieren, keine Entwürfe, kein Telegram, keine IMAP-Schreiboperation.

## 8. Risiken und offene Punkte

- **Response-Vertrag** (`DecisionsResponse`, Noul-Skala, Score-Bereich) ist erst nach T3/T12 bekannt. Bis dahin fail-closed (`unmapped`), keine erfundenen Felder.
- **`security_auth`-Policy** offen (D11): jede positive Shadow-Entscheidung bleibt `pending_policy`.
- **Datenschutz:** Auch ein gekürzter Auszug ist sensibel. Live- und Sample-Aufrufe erst nach Nicos Zustimmung und zunächst nur mit einem Testkonto; Datenschutz-/Logging-Einstellungen des OpenRouter-Accounts vor dem Live-Lauf prüfen.
- **Zwei Prozesse, ein SQLite-File:** Server und CLI teilen die Datei (WAL, `busy_timeout`); der Jev-Limiter gilt je Prozess (D10).
- **Dateimodus im Container:** POSIX-Rechte und UID-Zuordnung variieren zwischen Docker-Desktop (macOS) und Linux; im Zweifel Start verweigern statt Prüfung aufweichen.
- **Node-Pin:** `26.12.1` ist der lokal verifizierte Stand; vor dem Pi-Deployment ist die Verfügbarkeit für die Zielarchitektur zu prüfen. Ohne Update-Weg (Dependabot) bleiben Sicherheits-Patches liegen.
- **UI:** Der Starter hatte eine lokale Demo-Autorisierung. Das MVP bindet nur an `127.0.0.1`; vor jeder Netzwerk-Exposition Authentifizierung, Rate-Limits und Secrets-Handling neu planen.
- **Später (nicht jetzt):** Quarantäneregeln, Gmail-OAuth, Antwortentwürfe, Telegram, GPT-6-Luna-Agent, Pi/systemd, Second-Brain-Anbindung.

## 9. Definition of Done (bis zum Freigabepunkt)

Alle Tasks P–T22 committet; `npm run typecheck`, alle Offline-Tests und `npm run build` mit Exitcode 0; Docker-Smoke grün; zwei echte synthetische Fixtures und `docs/jev-contract.md` vorhanden; Schema-Test belegt, dass keine Inhaltsspalte existiert; kein Mailbox-Schreibpfad im Code; Abschlussbericht abgegeben.
