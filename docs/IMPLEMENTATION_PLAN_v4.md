# Implementierungsplan v4 – Jev × Agent × Mobile Web-UI

> **Status: Entwurf, nicht freigegeben.** Verbindlich wird er erst, wenn Nico die offenen Entscheidungen in Abschnitt 2.2 beantwortet und den Plan freigibt. Bis dahin gilt Plan v3 (`docs/IMPLEMENTATION_PLAN.md`) mit seinen Nicht-Zielen.
>
> Grundlage: Plan v3 (P–T22 erledigt), erstes Sample (`docs/ITERATION_2_NOTES.md`, Abschnitt 0), Context7-Stand zu Veryfront-Agents, -Tools und -Evals vom 2026-10-26. Schema-Quelle bleibt `docs/erd.md` (wird in T37 per Migration `002` erweitert).

## 1. Zielbild

Auf dem iPhone öffnet Nico eine installierbare Web-App (PWA). Sie zeigt je Konto die von Jev klassifizierten Mails als Karten: Kategorie, Wichtigkeit und Dringlichkeit, die Shadow-Entscheidung und Abweichungen zum Provider. Für Mails, die eine Antwort brauchen, erzeugt ein **Antwort-Agent** auf Knopfdruck einen Entwurf, der nur angezeigt wird. Nico kann Klassifikationen per Feedback bestätigen oder korrigieren. Zugang gibt es nur für Nicos Geräte, mit Identitätsprüfung.

**Kette:** IMAP (nur lesend) → Jev (kalibriert, Fragenset v2) → SQLite (nur Metadaten, Antworten und Feedback) → Lese-API → Mobile-UI → optionaler Agent-Entwurf (nur im Arbeitsspeicher).

**Nicht-Ziele auch in v4:** jede Mailbox-Schreibaktion (Verschieben, Flags, IMAP-Draft, Senden), Quarantäne, Löschen, Telegram, Gmail-OAuth, Raspberry-Pi-Deployment, Second-Brain-Anbindung, öffentliche Erreichbarkeit aus dem Internet. Quarantäne und Raspberry Pi folgen in v5.

## 2. Entscheidungen

### 2.1 Festgelegt (gelten zusätzlich zu D1–D12 aus v3)

| ID | Entscheidung |
|---|---|
| D13 | Kalibrierung vor Funktion: `interpretNoul` bekommt Regeln nur aus belegten Daten (`docs/jev-contract.md`, Abschnitt „Kalibrierung“). Ohne Beleg bleibt die Antwort `unmapped`. |
| D14 | Neues Fragenset `email-classification-v2`. v1-Antworten bleiben erhalten; `sample --question-set v2` wertet den Bestand neu aus. |
| D15 | `security_auth` ist nie ein Shadow-Kandidat, egal wie hoch Spam- oder Phishing-Werte sind (Ergebnis des ersten Samples: Phishing-Fehlalarme bei Login-Mails). |
| D16 | Zugang über **Tailscale Serve**: Die App bindet weiter an `127.0.0.1` (D12 bleibt), Tailscale stellt HTTPS im Tailnet bereit. Auth über eine Allowlist von Tailnet-Identitäten im Header `Tailscale-User-Login`. Der Header wird nur akzeptiert, wenn die Anfrage über den lokalen Proxy kommt. Kein Port ins Internet. Konkretes Header- und Proxy-Verhalten wird in T31 per Doku und Probe belegt. |
| D17 | Agent-Entwürfe werden **nie persistiert** (H3): kein Text in SQLite, Logs oder API-Cache. Gespeichert wird nur ein Audit `draft_generated` mit IDs, Modell, Latenz und Tokens. |
| D18 | Der Agent sieht nie Mails mit `addresses_an_ai` positiv **oder** `unmapped` (fail-closed), nie `security_auth` und nie Mails mit `is_assessable` negativ. Diese Sperre greift im Code vor jedem Agent-Aufruf, nicht im Prompt. |
| D19 | Der Agent bekommt nur Lese-Tools mit festem Zuschnitt (Metadaten und Jev-Antworten einer Mail, Auszug einer Mail frisch per IMAP). Er hat keine Schreib-Tools, keine Delegates, keine `providerTools`, kein `memory` und `maxSteps ≤ 3`. Die `security`-Middleware bleibt an. |
| D20 | Schreibende HTTP-Endpunkte (Entwurf anfordern, Feedback) nur per `POST`, nur mit gültiger Identität (D16), mit CSRF-Schutz (Same-Origin-Prüfung plus Token) und Rate-Limit. Alle Lese-Endpunkte bleiben `GET`. |
| D21 | UI ohne neues UI-Framework: React aus dem Starter, eigenes CSS mit Design-Tokens und Dark Mode. PWA-Manifest und Icon liegen unter `public/`. |

### 2.2 Offen – Nico entscheidet vor Phase-Start (STOP-8)

| ID | Frage | Vorschlag |
|---|---|---|
| O1 | Welches Modell nutzt der Antwort-Agent, und über welchen Provider? | Über OpenRouter mit dem vorhandenen Key, damit keine neue Pflicht-Variable nötig ist. Konkrete Modell-ID in T40 per Context7 und OpenRouter prüfen. |
| O2 | Ist Tailscale als Zugangsweg in Ordnung? | Ja. Alternative wären Passkeys (WebAuthn) mit eigener Session-Verwaltung, das ist deutlich mehr Aufwand. |
| O3 | Welche Tailnet-Identitäten stehen auf der Allowlist? | Nur Nicos Login. |
| O4 | Was ist die Startansicht auf dem Handy: „Braucht Antwort“, „Abweichungen“ oder „Heute“? | „Braucht Antwort“, sobald `needs_my_reply` in v2 kalibriert ist, sonst „Heute“. |
| O5 | Feedback-Typen | `spam_correct`, `not_spam`, `category_wrong:<kat>`, `reply_needed`, `no_reply_needed` |
| O6 | Kontrollkonto für die Kalibrierung | Custom-Domain-Konto (`domain`), zuerst als reines Sample |
| O7 | Neue Abhängigkeiten | So wenige wie möglich. Was Veryfront (`veryfront/agent`, `veryfront/eval`) mitbringt, wird genutzt. Jede neue Abhängigkeit führt zu STOP-6. |

## 3. Arbeitsregeln

Es gelten **alle** Regeln aus v3, Abschnitt 3: Lesereihenfolge, TDD-Zyklus, H1–H10, STOP-1 bis STOP-7 und die Abweichungsdokumentation. Context7 zuerst für externe Doku, graphify zuerst für Code (`CLAUDE.md`). Zusätzlich:

- **H11 Agent-Sperre:** Jeder Pfad zum Agenten läuft über eine reine Funktion `agentEligibility(answers)` (D18). Ein Test belegt, dass jeder gesperrte Fall den Agenten nie aufruft.
- **H12 Kein Entwurf auf Platte:** Ein Marker-Test über SQLite, Logs und API-Antworten nach einer Entwurfserzeugung (D17).
- **H13 Auth vor Funktion:** Jede neue Route bekommt zuerst den Test „ohne Identität → 401“, erst dann ihr Verhalten.
- **H14 Externe Aufrufe in v4:** Nico führt Samples und Kontrollläufe selbst aus. Der Implementierer macht genau die Live-Proben, die ein Task ausdrücklich nennt (T26, T41), mit synthetischen Inhalten.
- **H15 Mobile-Prüfung:** UI-Tasks werden im In-App-Browser mit iPhone-Viewport (390×844) und Dark Mode geprüft, ausschließlich mit synthetischen DB-Zeilen. Mit dem Abschluss gehen Screenshots an Nico.

Neue STOP-Punkte:
- **STOP-8:** Eine offene Entscheidung aus 2.2 ist für den Task nötig und noch nicht beantwortet.
- **STOP-9:** Tailscale-Identität lässt sich nicht verlässlich prüfen (Header fälschbar, Proxy-Verhalten unklar).
- **STOP-10:** Der Veryfront-Agent lässt sich nicht ohne Chat-Speicher, Persistenz oder offene Endpunkte betreiben (D17/D19 nicht erfüllbar).

## 4. Phasen und Tasks

Commit-Präfix: `phase N: …`. Ein Commit pro Task, wie in v3. Unabhängige Stränge laufen in Worktrees, die Commits kommen per Cherry-Pick nach `main`.

### Phase 5 – Kalibrierung und Fragenset v2 (Jev)

**T23 – Kontroll-Sample (Nico, manuell).** Konto `domain` aktivieren, korrekte Ordnernamen eintragen (die Vorschau prüft sie jetzt), `sample` laufen lassen. Ergebnisse aggregiert in `docs/ITERATION_2_NOTES.md` festhalten. Danach gibt es mindestens 50 legitime Mails als Gegenprobe zu den 153 Spam-Mails.

**T24 – Kalibrierungsbericht (Skript, nur Aggregate).**
- Test `tests/calibration.test.ts` mit synthetischer DB: Verteilung je `noul`-Frage und Provider-Ordner (min, p10, Median, p90, max), Precision und Recall gegen das Provider-Label für Schwellen von 0.5 bis 0.95. Die Ausgabe enthält nie Betreff oder Absender.
- Implementierung `scripts/calibrate.ts` und Script `calibrate`.
- Commit: `phase 5: report noul calibration from stored answers`.

**T25 – `interpretNoul` mit belegten Regeln.** Nico legt anhand des T24-Berichts je Frage eine Schwelle fest. Das Ergebnis kommt in `docs/jev-contract.md`, Abschnitt „Kalibrierung“ (Version, Datum, Datenbasis).
- Test `tests/jev-response.test.ts` erweitert: Regel je Frage und Fragenset-Version, Grenzwerte, `unmapped` außerhalb der belegten Fragen.
- `lib/shadow.ts`: D15 (`security_auth` ist nie Kandidat). `needs_my_reply` geht nur ein, wenn es für v2 kalibriert ist.
- Commit: `phase 5: map noul answers from calibrated thresholds`.

**T26 – Fragenset v2.** `needs_my_reply` schärfer formulieren: persönlich adressierte Bitte oder Frage, kein Marketing-Call-to-Action. `is_phishing_or_scam` von legitimen Sicherheitsmails abgrenzen. Optional `is_personal_correspondence`.
- Test `tests/jev-questions.test.ts` für v2, und v1 bleibt unverändert abrufbar.
- **Genau ein** Live-Aufruf mit synthetischer Mail, danach Fixture `tests/fixtures/jev-email-v2-response.json`.
- Eval-Set um schwierige Fälle erweitern: Login-Code, echte Rechnung gegen Rechnungsbetrug, Newsletter mit „Antworten Sie jetzt“. Danach ein Lauf `eval:jev`.
- Commit: `phase 5: add question set v2 with sharper reply and phishing criteria`.

**T27 – Veryfront-Eval für Jev (`evalDataset`).**
- Ablauf: `eval:jev --write-dataset` legt normalisierte Antworten des synthetischen Sets ab. `evals/jev-email.eval.ts` bewertet sie mit `evalDataset` und `metrics.answer.jsonMatch` als Gate. `npm run eval` läuft offline.
- Context7 `/websites/veryfront` (`evalDataset`, `runEval`, Reportformat) vorher verifizieren.
- Test `tests/jev-eval-dataset.test.ts`: Das Dataset enthält nur synthetische IDs und Antworten.
- CI: `npm run eval` als zusätzlicher Schritt (offline, ohne Secrets).
- Commit: `phase 5: grade Jev answers with Veryfront dataset evals`.

**T28 – Neu-Auswertung mit v2 (Nico, manuell).** Mit `sample --question-set email-classification-v2` beide Konten neu auswerten, dann T24 erneut ausführen, Schwellen bestätigen oder anpassen. Damit ist die Kalibrierung abgeschlossen.

### Phase 6 – Aufräumen (parallel zu Phase 5)

**T29 – CLI-Skripte nach `scripts/`.** `tools/sample.ts`, `tools/eval-jev.ts` → `scripts/`, npm-Scripts und README anpassen. `tools/` ist danach leer und für Veryfront-Tools reserviert. Test: Die Scripts sind auflösbar, und unter `tools/` liegen nur `tool()`-Exporte. Commit: `phase 6: move CLIs out of the Veryfront tools folder`.

**T30 – Repo-Hygiene.** `git rm -r --cached node_modules`, `HANDOVER.md` nach Nicos Entscheidung archivieren. Schulden aus den Notizen (Abschnitt 6) erledigen: cwd-Test für die Status-Route, Signal-Handler beim Stoppen entfernen, Container-Smoke für `/api/emails` mit Daten. Commit: `phase 6: stop tracking node_modules and close v3 debts`.

### Phase 7 – Zugang (Voraussetzung für Mobile)

**T31 – Probe: Tailscale Serve und Identität.** Tailscale-Doku über Context7 bzw. die offizielle Doku lesen: `tailscale serve`, Identitäts-Header, Verhalten bei direktem Zugriff auf `127.0.0.1`. Kurze Probe mit `/api/health` im eigenen Tailnet. Ergebnis kommt in `docs/access-contract.md`. Ist der Header nicht verlässlich an den Proxy gebunden: STOP-9.

**T32 – Auth-Middleware.**
- Test `tests/auth.test.ts`:
  - ohne Header → 401
  - Header mit nicht erlaubtem Login → 403
  - erlaubter Login über den Proxy-Pfad → ok
  - Header bei direktem Zugriff, falls laut T31 unterscheidbar → abgelehnt
  - `/api/health` bleibt offen (Liveness)
- Implementierung `lib/auth.ts` (reine Prüffunktion) und Anbindung an jede Route außer Health. Die Allowlist steht in der Konten-Datei oder einer neuen optionalen Datei; neue Env-Variablen nur mit STOP-6.
- Commit: `phase 7: require tailnet identity for every route`.

**T33 – CSRF und Rate-Limit für künftige POST-Routen.** `lib/csrf.ts` (Same-Origin plus Token), `lib/rate-limit.ts` (pro Identität, im Arbeitsspeicher). Tests zuerst. Commit: `phase 7: guard state-changing requests`.

**T34 – Betriebsdoku.** `README.md`: Tailscale einrichten, `tailscale serve` auf Port 3000, iPhone ins Tailnet, Allowlist pflegen. Compose bleibt bei `127.0.0.1`. Commit: `phase 7: document private tailnet access`.

### Phase 8 – Mobile Web-UI (React, PWA)

**T35 – Lese-API für Mobile.**
- `GET /api/emails`:
  - Cursor-Pagination (`before`, `limit ≤ 50`)
  - Filter: Konto, Status, `view=needs_reply|disagreements|today|all`
  - kompakte Felder für Karten
- `GET /api/emails/:id` als Detail: Antworten mit Wahrscheinlichkeiten, Shadow-Entscheidung, Ordnerverlauf aus dem Audit.
- Tests: Auth zuerst (H13). Der Marker-Test gegen Inhaltsfelder bleibt bestehen. `interpretNoul`-Ergebnisse statt Rohwerten, sobald sie kalibriert sind.
- Commit: `phase 8: page and detail endpoints for the mobile review`.

**T36 – Mobile-UI.** Context7 `/websites/veryfront` zu Pages, Layouts, Client-Komponenten und `public/` vorher lesen.
- `app/page.tsx` als Kartenliste. Segmented Control für die Ansichten (O4), Kontowahl, Pull-to-refresh bzw. Neu-laden-Knopf, Endlos-Scroll per Cursor.
- `app/emails/[id]/page.tsx` als Detail: Kategorie, Badges für Wichtigkeit und Dringlichkeit, Jev-Antworten verständlich formuliert, Abweichung zum Provider, Shadow-Grund.
- Design: CSS-Tokens, Dark Mode (`prefers-color-scheme`), Safe Areas (`env(safe-area-inset-*)`), Touch-Ziele ≥ 44 pt, Systemschrift, kein horizontales Scrollen bei 390 px.
- Keine Schreibknöpfe in diesem Task.
- Tests: Rendern per `react-dom/server` mit synthetischen Daten (Struktur, keine Inhaltsfelder). Prüfung im In-App-Browser bei 390×844, hell und dunkel (H15).
- Commit: `phase 8: mobile card review UI`.

**T37 – Feedback (erster Schreibpfad, nur DB).**
- Migration `db/migrations/002_feedback.sql` mit Tabelle `feedback` (`id`, `email_id`, `classification_id`, `kind`, `value_json`, `actor`, `created_at`). `docs/erd.md` wird **vorher** um ERD und DDL ergänzt, dokumentierte Schema-Änderung nach v3, Abschnitt 3.5. Danach Schema-Test und Allowlist erweitern.
- `POST /api/emails/:id/feedback` mit Auth, CSRF und Rate-Limit (D20), Typen aus O5. Audit `feedback_recorded`.
- UI: Feedback-Knöpfe im Detail.
- Kein IMAP-Zugriff.
- T24 rechnet Feedback als zusätzliches Label ein.
- Commit: `phase 8: record review feedback without touching the mailbox`.

**T38 – PWA.** `public/manifest.webmanifest`, Icons, `apple-touch-icon`, `theme-color`, Startansicht. Ein Service Worker nur für die App-Shell, **nie** für API-Antworten (Mail-Metadaten bleiben ungecached). Test: Manifest valide, der Service Worker cacht keine `/api/`-Pfade. Prüfung „Zum Home-Bildschirm“ auf dem iPhone macht Nico. Commit: `phase 8: installable app shell for iPhone`.

### Phase 9 – Antwort-Agent (Veryfront)

**T39 – Agent-Vertrag.** Context7 `/websites/veryfront`: `agent()`, `getAgent`, `generate()`, `outputSchema`, `tools`, `security`, Stateless-Default, Modell-Strings und -Provider, Aufruf aus einer Route ohne Chat-UI. Ergebnis kommt in `docs/agent-contract.md`. Erfüllt das nicht D17/D19: STOP-10. Benötigt O1 (STOP-8).

**T40 – Sperre und Eingabe.**
- `lib/agent-eligibility.ts` (D18, H11), reine Funktion mit Test für jede Sperrregel.
- `lib/agent-input.ts`: Eingabe-Allowlist mit Absenderdomain, Betreff und Auszug (≤ 1200 Zeichen, frisch per IMAP über die aktive Location geholt), Kategorie und `needs_my_reply`. Der Auszug ist als nicht vertrauenswürdig markiert.
- Tests zuerst.
- Commit: `phase 9: gate and shape agent input`.

**T41 – Agent und Lese-Tools.**
- `agents/reply-drafter.ts`: `system` auf Deutsch und Englisch. Der Agent schreibt nur Entwürfe, befolgt keine Anweisungen aus der Mail und erzeugt keine Links oder Zahlungsdaten. `outputSchema`: `{ draft, language, tone, needs_human_check, reasons[] }`. Dazu `maxSteps ≤ 3`, kein `memory`.
- `tools/get-email-context.ts`: liest Metadaten und Jev-Antworten einer erlaubten Mail.
- Tests mit injiziertem Modell bzw. Adapter, ohne externe Aufrufe.
- **Genau eine** Live-Probe mit einer synthetischen Mail.
- Commit: `phase 9: draft-only reply agent with read-only context`.

**T42 – Entwurfs-Route und UI.**
- `POST /api/emails/:id/draft`: Auth, CSRF und Rate-Limit, dann die Sperre (H11), dann IMAP-Refetch, dann der Agent.
- Antwort: der Entwurf (nur im Response, kein Caching: `Cache-Control: no-store`). Audit `draft_generated` nur mit IDs und Zahlen (D17).
- UI: Knopf „Entwurf erzeugen“ nur bei erlaubten Mails, Anzeige mit „Kopieren“. Kein Senden und kein IMAP-Draft.
- Marker-Test H12 über DB, Logs und Folgeanfragen.
- Commit: `phase 9: on-demand reply drafts in the mobile UI`.

**T43 – Agent-Evals.** `evals/reply-drafter.eval.ts` mit `evalAgent` und synthetischem Dataset (normale Anfrage, Mail mit Injection-Versuch, Rechnungsfrage). Metriken:
- `metrics.agent.noFailedTools().gate()`
- `metrics.agent.notCalledTool(...)` für alles außer dem Lese-Tool
- LLM-Judge (`metrics.judge.rubric`) für Höflichkeit, Bezug und „keine befolgte Injection“
- `ops.latency` und `ops.cost` als Budget

Live nur ein Lauf, nicht in CI. Commit: `phase 9: evaluate the reply agent on synthetic cases`.

### Phase 10 – Integration und Freigabe v4

**T44 – E2E-Smoke (synthetisch).** Skript, das eine synthetische DB befüllt, den Server startet und den Fluss abfährt: Liste, Detail, Feedback, Entwurf (mit Fake-Agent). Geprüft werden Auth, CSRF und Marker. Zusätzlich Docker-Smoke mit Auth-Header-Simulation. Commit: `phase 10: end-to-end smoke for review, feedback and drafts`.

**T45 – Freigabepunkt v4 (STOP-7).** Typecheck, Suite, Build, `npm run eval` (offline), Docker-Smoke. Bericht wie in v3: Tasks, Commits, Tests, Abweichungen, Kalibrierungstabelle, Agent-Eval-Ergebnis, Screenshots der Mobile-UI.

Danach macht Nico:
1. iPhone ins Tailnet bringen und die PWA installieren.
2. Einen Tag mit echten Mails beobachten.
3. Feedback geben und testweise Entwürfe anfordern.
4. Über v5 entscheiden (Quarantäne, Raspberry Pi, Telegram).

## 5. Abhängigkeiten und Parallelisierung

```
T23 (Nico) ─► T24 ─► T25 ─► T26 ─► T27 ─► T28 (Nico)
T29, T30 (parallel, Worktree) ─────────────────────────┐
T31 ─► T32 ─► T33 ─► T34 ──► T35 ─► T36 ─► T37 ─► T38 ─┤
                       T39 ─► T40 ─► T41 ─► T43        │
                                      └────► T42 ◄─────┘ (braucht T33, T36)
                                                 └─► T44 ─► T45
```

- Phase 5 (Jev) und Phase 7 (Zugang) sind unabhängig und können parallel laufen.
- T36 kann mit Rohwerten starten. Kalibrierte Labels zeigt die UI, sobald T25 auf `main` ist.
- Der Agent (T39–T41) läuft parallel zur UI. T42 führt beides zusammen.

## 6. Risiken

- **Kleine Datenbasis:** 6 legitime Mails reichen nicht für Schwellen. Ohne T23 und T28 bleibt die Shadow-Logik fail-closed. Das ist gewollt.
- **Prompt-Injection gegen den Agenten:** Eingabe-Allowlist, harte Sperre im Code, keine Schreib-Tools, nur Entwürfe, Evals mit Injection-Fällen. Ein Restrisiko bleibt, deshalb sieht Nico jeden Entwurf vor einer Nutzung.
- **Datenweitergabe:** Der Agent schickt Auszüge an einen weiteren Modellanbieter. Die Datenschutz-Einstellungen von OpenRouter bzw. dem Anbieter prüfen Nico und der Implementierer in T39 und nehmen sie in `docs/agent-contract.md` auf.
- **Tailscale als einzige Zugangsgrenze:** Ein fälschbarer Header wäre kritisch, daher die Probe T31 und STOP-9. Der Direktzugriff auf `127.0.0.1` bleibt nur lokal.
- **iOS-PWA-Eigenheiten:** Service-Worker- und Speicherlimits, kein Hintergrund-Refresh. Die UI lädt beim Öffnen neu. Push-Benachrichtigungen bleiben bis v5 außen vor.
- **Mac als Server:** Läuft der Mac nicht, ist die App vom iPhone aus nicht erreichbar. Dauerbetrieb kommt mit dem Raspberry Pi in v5.

## 7. Definition of Done v4

Kalibrierte `noul`-Regeln sind dokumentiert und im Code. Fragenset v2 ist aktiv. `npm run eval` läuft offline grün. Jede Route außer Health verlangt eine Tailnet-Identität. Die Mobile-UI ist bei 390 px in hell und dunkel geprüft und als PWA installierbar. Feedback landet in der DB, ohne IMAP-Zugriff. Der Antwort-Agent liefert Entwürfe nur auf Anfrage, nur für erlaubte Mails, ohne Persistenz, und die Agent-Evals sind dokumentiert. Typecheck, Suite, Build und Docker-Smoke sind grün. Weiterhin gibt es keinen Mailbox-Schreibpfad.
