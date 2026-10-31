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
| Eingaben/Ausgaben werden still geprüft | Standard-Security-Middleware aktiv, solange `security` nicht `false` | vor R2 mit synthetischen Mails prüfen (ADR 0029) |
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
