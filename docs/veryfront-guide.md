# Veryfront: Bausteine, Nutzung, Tipps und Fallstricke

> Stand 2026-10-31, `veryfront` 0.1.1285 (gepinnt). Quellen: installierter Code (`node_modules/veryfront/esm/src`), https://veryfront.com/docs (Index: https://veryfront.com/docs/llms.txt), Context7 `/websites/veryfront`. Entscheidungen: ADR 0001, 0011, 0029–0031. Bei Widerspruch zwischen Doku und installiertem Code gilt der Code.

## 1. Bausteine (Primitives) und unsere Nutzung

Nach https://veryfront.com/docs/code/guides/choose-a-primitive:

| Baustein | Wofür (laut Veryfront) | Bei uns | Hinweis |
|---|---|---|---|
| App-/API-Route (`app/`) | Seiten, Endpunkte, Webhooks | **ja** | Guard als `requestInterceptor`, nie Root-`middleware.ts` |
| Einzelner Modellaufruf (`veryfront/llm`, `generate()`) | Extraktion, Klassifikation, Routing | Jev läuft direkt über `@openrouter/sdk` | Briefing (ohne Tools) wäre ein Kandidat |
| Agent (`agents/<id>.ts`, `agent()`) | Modell entscheidet, ruft Tools, streamt | **ja**: `replyDrafter`, `briefing` | ID = Dateiname; neutrale `description` (siehe Fallstricke) |
| Tool (`tools/<id>.ts`, `tool()`) | typisierte Operation | **ja**: `get-email-context` | dünne Hülle, Logik + Gate in `lib/` (ADR 0029) |
| Skill (`skills/<id>/SKILL.md`) | wiederverwendbare Anweisungen | nein (`skills: false`) | später für Schreibstil; `allowed-tools` wird **nicht** durchgesetzt |
| Prompt, Resource | Vorlagen, Ressourcen (MCP) | nein | – |
| Eval (`evals/*.eval.ts`) | Qualitätsmessung | **ja**: `npm run eval` | Offline-Gate in CI |
| Task (`tasks/`) | Hintergrundfunktion | nein | eigener Worker statt Task |
| Workflow (`workflows/`) | Schritte, Verzweigung, Retry, Freigabe (`waitForApproval`, `waitForEvent`, `branch`) | nein | Speicher: Memory oder Redis; eigenes SQLite-Backend möglich (ADR 0030 Stufe 2) |
| Run, Schedule | dauerhafte Ausführung, Zeitpläne | nein | braucht Veryfront Cloud + `VERYFRONT_API_TOKEN` |
| Integration (OAuth, z. B. `gmail__*`) | Provider-Konten | nein | läuft über Veryfront Cloud; Option fürs go2market-Gate |
| MCP-Server | Tools über MCP | aus | Policy kennt nur `approval: "never"` |
| Knowledge (`knowledge/`) | RAG über Projektdateien | nein | nur `local-json` oder Cloud, projektweit, kein Schreib-Tool → für Präferenzen eigene Tabelle (ADR 0031) |
| Sandbox | isolierte Code-/Shell-Ausführung | nein | braucht Cloud oder eigene Sandbox-API |
| Extension | Erweiterungen (Bundler, OTel, …) | Bundler ja | `@veryfront/ext-observability-opentelemetry` existiert (Inhalt der Spans ungeprüft) |
| Hooks am Agenten | `middleware` (ganzer Durchlauf), `onToolCall` (nur beobachten), `onToolResult` (nach Ausführung), `resolveRuntimeState`, `resolveModelTransport` | nur `onChunk`/`onFinish` beim Streaming | Audit/Tracing ja, **Gate nein** (kein Hook vor einem einzelnen Tool) |

## 2. Wie Veryfront registriert

- Beim Start durchsucht `discoverAll()` die Ordner `tools/`, `skills/`, `agents/`, `workflows/` (`discovery/discovery-engine.js`). IDs kommen aus dem Dateinamen.
- Ein Agent wählt Tools über `tools`:
  - `{ "get-email-context": true }` → genau dieses entdeckte Tool (unser Weg),
  - `true` → **ganzer Katalog** über `veryfront__tool_search` (nie verwenden),
  - `{ name: toolObjekt }` → Tool-Objekt direkt, ohne Ordner,
  - weggelassen → keine Tools.
- `tool({ inputSchema, execute, outputSchema?, mcp? })`: Veryfront parst die Eingabe gegen das Schema, ruft `execute`, gibt das Ergebnis ans Modell. Keine Approval-Option.
- Tool-Freigaben gibt es nur in Studio/Cloud („Require approval“), in Workflows (`waitForApproval`) und in der Claude-Code-Workflow-Anbindung (`ToolApprovalConfig`).

## 3. Tipps

1. **Tool-Muster:** `lib/<name>.ts` (Schema + reine Funktion + typisiertes Ergebnis) → `tools/<id>.ts` (Hülle: Gate, dann Kern). Fehler/Ablehnung als `{ ok: false, code }`, nie Exception ans Modell.
2. **Agent-Konfiguration exportieren** (`export const replyDrafterConfig`) und per Test prüfen: Modell, `allowedModels`, explizite Tools, `skills: false`, `mcpServers: []`, `maxSteps`.
3. **Streaming:** `agent.stream({ onChunk, onFinish })` liefert `toDataStreamResponse()`; wir lesen den Stream serverseitig aus und schicken eigenes SSE (`lib/sse.ts`).
4. **Modelle über OpenRouter:** Veryfronts OpenAI-Provider mit `OPENAI_BASE_URL`; `lib/openrouter-env.ts` leitet aus `OPENROUTER_API_KEY` ab (nie einen echten `OPENAI_API_KEY` überschreiben). Modell-String `openai/<openrouter-modell>`, z. B. `openai/openai/gpt-6-luna`.
5. **Evals** über `veryfront/eval` (`evalDataset`, `metrics`), deterministische Checks in `lib/agent-eval-checks.ts`.
6. **Dev:** erster Aufruf einer Route kompiliert (2–3 s) → in Playwright auf Antworten warten (`waitForResponse`).

## 4. Fallstricke (alle selbst erlebt)

| Problem | Ursache | Lösung |
|---|---|---|
| 500 auf allen Routen im gehärteten Container | Root-`middleware.ts` wird als `.vf-middleware-<uuid>.mjs` neben die Quelle geschrieben → `EACCES/EROFS` | Guard als `requestInterceptor` (`lib/auth-runtime.ts`); Test `tests/no-root-middleware.test.ts` |
| API-Routen scheitern in Produktion mit `WorkerEgressBlockedError` | `createHandler` führt Routen im Sandbox-Worker aus | `startServer` mit `requestInterceptor` statt `createHandler` |
| UI ohne Styles | CSS-Scanner bricht bei > 100k Kandidaten ab, wenn Worktrees mit `node_modules` im Projekt liegen | Worktrees außerhalb des Repos bzw. sofort löschen; `lib/dev-hazards.ts` warnt |
| `startServer` startet nicht | Bundler/ModuleLexer nicht registriert | `server.ts` registriert sie selbst (DEVIATIONS T2) |
| HTTPS-Erkennung hinter fly falsch | Veryfront entfernt `x-forwarded-*` vor den Routen | `Secure`-Cookie im Passwort-Modus unbedingt |
| POST 403 in Tests | eingebautes Double-Submit-CSRF; Cookie nur bei `Accept: text/html` | Client `csrfMutationHeaders` (`veryfront/index.client`); Tests senden `Accept: text/html` |
| `agent.stream()` ist kein async iterable | API-Form | `onChunk`/`onFinish` + `toDataStreamResponse()` |
| Agenten sichtbar ohne Login | `GET /api/agents` listet Agenten | neutrale `description`, keine Interna |
| Ganzer Tool-Katalog freigegeben | `tools: true` | immer explizite Liste |
| Eingaben/Ausgaben werden still geprüft | Standard-Security-Middleware aktiv, solange `security` nicht `false`; `security` kennt nur `false`, die Standardwerte sind nicht konfigurierbar | geprüft 2026-10-31, bewusst behalten: Abschnitt 6, Test `tests/agent-security-middleware.test.ts`. Folgen: englische Injection-Muster brechen den Lauf ab (auch harmlose wie „you are now a …“), Entwurfstexte verlieren E-Mail-Adressen und 10-stellige Zahlen (`[EMAIL]`, `[PHONE]`) |
| Upload von Daten bei `deploy` | Standard-Ignore reicht nicht | `.vfignore` (data/, .env*, SQLite) |
| Interne Pfade | Tests laden `node_modules/veryfront/esm/src/extensions/builtin-schema-validator.js`; Guard kennt `/_veryfront/`, `/_vf_modules/`, `/_vf_styles/` | bei Veryfront-Update mitprüfen |
| Schnelle Versionen | 0.1.x mit häufigen Patch-Builds | Version pinnen, Update nur mit vollem Gate + Docker-Smoke |

## 5. Speicher: was SQLite kann (statt Redis/Postgres-Extras)

| Bedarf | Postgres | Redis | SQLite (`node:sqlite`, bei uns) |
|---|---|---|---|
| Volltextsuche | `tsvector` | RediSearch | **FTS5** (eingebaut, geprüft) |
| JSON-Felder | `jsonb` | RedisJSON | **JSON1** (`json_extract`, geprüft) |
| Vektorsuche | `pgvector` | Vector Sets | `sqlite-vec` (Erweiterung, `allowExtension: true` + `loadExtension`) |
| Queue / Jobs | `pgmq`, Graphile Worker, `SKIP LOCKED` | Lists/Streams | Tabelle + Worker-Durchlauf (ein Prozess, keine Konkurrenz) |
| Locks | Advisory Locks | `SET NX` | Transaktion (`BEGIN IMMEDIATE`) im einzigen Prozess |
| Pub/Sub | `LISTEN/NOTIFY` | Pub/Sub | im Prozess (EventEmitter), SSE nach außen |
| Veryfront-Workflow-Backend | – | `RedisBackend` (nutzt Lua `EVAL` + Streams) | eigenes `SqliteWorkflowBackend` möglich (ADR 0030 Stufe 2) |

Redis-Nachbauten auf SQLite (z. B. Redka) sind eigene Server und unterstützen Lua-Skripte/Streams nicht verlässlich; für Veryfronts `RedisBackend` daher ungeeignet.

## 6. Security-Middleware (geprüft 2026-10-31)

Auftrag: ADR 0029 Punkt 8. Geprüft wurden statisch der installierte Code (`veryfront` 0.1.1285) und dynamisch echte Agenten (`agents/briefing.ts`, `agents/reply-drafter.ts`) mit synthetischen Mails gegen ein Fake-Modell (`registerModelProvider("openai", …)`, kein Netz, kein Schlüssel; 0 Live-Aufrufe). Der Code gilt vor der Doku.

**Was sie ist.** `resolveSecurityMiddleware` (`agent/factory.js` Z. 461–476, aufgerufen in Z. 412) stellt jedem Agenten eine Middleware voran, außer bei `security: false`. Fest verdrahtet: `input.blockedPatterns = COMMON_BLOCKED_PATTERNS.promptInjection`, `output.filterPII = true`. `AgentConfig.security` ist als `security?: false` typisiert (`agent/types.d.ts` Z. 297): Die Standardwerte lassen sich nicht setzen. „Explizit konfigurieren“ ginge nur über `security: false` plus eigenes `middleware: [securityMiddleware({...})]`.

**Eingabe** (`agent/middleware/security/validator.js`):
- Sieben Regexe (Z. 20–28): `ignore previous instructions`, `ignore all previous prompts`, `you are now a`, `pretend you are`, `system:` am Zeilenanfang, `<|im_start|>`, `<|im_end|>`; alle englisch, `/i`.
- Treffer = `throw` „Input validation failed: Input matches blocked pattern“ (Z. 818–829), **vor** dem Modellaufruf; die Meldung enthält keinen Mailinhalt. Wir fangen das bereits als `agent_failed` bzw. Briefing-Fallback.
- Geprüft werden nur Text von `user`/`system`-Nachrichten (Z. ~337 `VALIDATED_INPUT_ROLES`) plus aus Teilen zusammengesetzte Texte. Assistenten- und **Tool-Ergebnisse werden nicht geprüft und nicht verändert** (Test: ein feindlicher Betreff aus `get-email-context` erreicht das Modell unverändert).
- Kein Längenlimit (600 KB in ~1 ms), `sanitize` ist aus (kein Entfernen von HTML/Script), keine eigene `validate`-Funktion. XSS-, SQL- und Exfiltrationslisten (`password`, `token` …) gehören **nicht** zum Standard.

**Ausgabe** (Z. 33–40, 200–245, 1536–1558):
- Ersetzt in `text` und rekursiv in strukturierten Daten (`data`/`object`, auch `reasons`): E-Mail → `[EMAIL]`, Telefonnummern wie `+49 170 1234567` oder `0301234567` (jede 10-stellige Ziffernfolge, auch Bestell- und Referenznummern) → `[PHONE]`, `123-45-6789` → `[SSN]`, 16 Ziffern → `[CREDIT_CARD]`. Still: kein Hinweis an Modell, UI oder Log.
- Lücken: IBAN wird nur teilweise zerstückelt (`DE89 [CREDIT_CARD] 00`), Telefon mit Leerzeichen-Gruppen `030 1234 5678` bleibt, Datum, Betrag und URL bleiben.

**Netz, Logging, Latenz.** Kein `fetch`, kein `console`, keine Telemetrie im Validator; `onViolation` ist nicht gesetzt, also nichts wird protokolliert. Reine Regex-Läufe, Millisekunden.

**Ergebnis der Probe** (Test `tests/agent-security-middleware.test.ts`):

| Eingabe | Ergebnis |
|---|---|
| 7 englische Injection-Sätze im Mailauszug, 1 im Briefing-Betreff | blockiert, kein Modellaufruf |
| „Congratulations, you are now a member …“ | **blockiert (Fehlalarm)** |
| Deutsche Injection („Ignoriere alle vorherigen Anweisungen …“), geschlossener Fence `</untrusted_email_excerpt>`, `<script>`, SQL, „password/token/api key“ | durchgelassen |
| 14 harmlose synthetische Mails (de/en, inkl. „Please ignore the previous email“, „Systemstatus: ok“, „password was changed“) und Briefing-Betreffe | 0 von 14 blockiert (0 %) |
| Entwurf mit E-Mail, Telefon, Karte, 10-stelliger Referenz | `[EMAIL]`, `[PHONE]`, `[CREDIT_CARD]`, `[PHONE]`; Datum bleibt |

**Zusammenspiel mit unseren Schutzmaßnahmen.** Die Middleware ersetzt nichts: Das Fence in `lib/agent-input.ts` (schließende Tags werden zu `[removed tag]`), das Eignungs-Gate (H11), der Prompt und die Allowlist der Tools tragen die Abwehr; deutsche und strukturelle Angriffe erreichen das Modell trotz Middleware. Doppelt behandelt wird nur die englische Muster-Klasse; das ist harmlos (fail-closed). Eine feindliche Mail kann den Entwurf dieser Mail abbrechen, ein feindlicher Betreff unter den 25 Betreffen das Modell-Briefing (dann greift `fallbackBriefing`); das ist kein Datenverlust.

**Entscheidung: behalten, nicht ersetzen** (kein neues ADR, ADR 0029 Punkt 8 ist damit erledigt):
1. Fail-closed passt zur Linie des Projekts; der Fehlalarm kostet höchstens einen Entwurf, den Nico selbst schreibt, bzw. den Fallback-Text.
2. Kein Netz, kein Logging, kein Inhalt in Fehlern; Datenschutz H3 bleibt gewahrt. Die Ausgabe-Schwärzung ist eine zusätzliche Sperre gegen Rückgabe von Adressen und Nummern (die Prompts verbieten sie ohnehin).
3. Ersetzen würde `security: false` plus eigene Muster und eigene Schwärzung in `lib/` bedeuten; das ergäbe mehr Eigencode ohne Gewinn, solange die Muster die einzige Lücke sind. Wird deutsche Erkennung oder ein Verzicht auf die PII-Schwärzung gebraucht, dann per neuem ADR mit `security: false` und `securityMiddleware({...})` (`securityMiddleware` steckt in `agent/middleware/security/validator.js` Z. 1384 und ist über den öffentlichen Einstieg `veryfront/agent` nicht exportiert; Tiefenimport wäre nötig).
4. Absicherung gegen Updates: `tests/agent-security-middleware.test.ts` legt das heutige Verhalten fest (blockierte Muster, bekannte Lücken, Fehlalarm, 0/14 harmlose, Ausgabe-Ersetzung, Tool-Ergebnisse unangetastet, kein Netz/Log). Schlägt er nach einem Update fehl, diesen Abschnitt und den Test gemeinsam anpassen.

Nebenwirkung für die UI: Entwürfe können `[EMAIL]` oder `[PHONE]` enthalten, wenn das Modell eine Adresse oder lange Zahl schreibt; der Nutzer sieht das im Entwurf und setzt den Wert selbst ein.
