# Antwort-Agent: Veryfront-Vertrag (T39)

> Stand: 2026-10-26, `veryfront` 0.1.1285. Quellen in dieser Reihenfolge (H6): Context7 `/websites/veryfront`, danach die installierten Typen und der Code unter `node_modules/veryfront/esm/src`. Live-Aufrufe: keine.
>
> **Ergebnis:** D17 und D19 sind erfüllbar (kein STOP-10). **STOP-8 für O1:** Der Weg „OpenRouter mit dem vorhandenen Key, ohne neue Variable“ ist mit der öffentlichen Veryfront-API nicht ohne Weiteres gangbar. Nico wählt unten eine Option, bevor T41 einen Provider anbindet.

## 1. Agent definieren

`agent()` aus `veryfront/agent`, Datei `agents/reply-drafter.ts`, Aufruf aus der Route über `getAgent("reply-drafter")` (Rückgabe `Agent | undefined`, vorher prüfen) und `agent.generate({ input, outputSchema?, abortSignal? })`. Die Antwort enthält `text`, `toolCalls`, `usage` und bei `outputSchema` die geparsten Daten in `data`/`object`. Ein Aufruf aus einer Route braucht keine Chat-UI: `createAgUiHandler` und `agent.respond()` sind optional und werden nicht genutzt.

Pflichtfelder für D17/D19 (Typen: `AgentConfig` in `esm/src/agent/types.d.ts`):

| Feld | Wert | Warum |
|---|---|---|
| `model` | immer explizit setzen, zusätzlich `allowedModels: [model]` | Ohne `model` wählt Veryfront Cloud oder `openai/gpt-5-nano`. `allowedModels` sperrt Modell-Overrides pro Anfrage. |
| `memory` | weglassen | Laut Typ-Doku ist das der zustandslose Standard: Jeder Aufruf läuft isoliert. `{ type: "conversation", enabled: false }` erzwingt dasselbe ausdrücklich. |
| `tools` | explizite Map, nur `{ "get-email-context": true }` | Wer `tools` weglässt, hat keine Projekt-Tools. `true` würde den ganzen Katalog über `veryfront__tool_search` freigeben. |
| `skills` | **`false`** | Achtung: Wer `skills` weglässt, gibt dem Agenten **alle** gefundenen Skills. `false` blendet alle aus und sperrt `veryfront__load_skill`. |
| `mcpServers` | `[]` | Ohne diese Angabe wird mit Cloud-Zugangsdaten automatisch der Veryfront-API-MCP-Server eingebunden. |
| `delegates`, `providerTools`, `knowledge`, `sandbox` | weglassen | Ohne Angabe sind sie aus. |
| `maxSteps` | `3` | D19 |
| `outputSchema` | `defineSchema(...)` mit `{ draft, language, tone, needs_human_check, reasons[] }` | Nicht unterstütztes Structured Output führt zur Ablehnung, nicht zum stillen Weglassen. |
| `security` | weglassen | Nur `false` würde die Standard-Security-Middleware abschalten. |
| `temperature` | Standard 0 | |

Ein Test in T41 prüft diese Felder an der exportierten Konfiguration.

## 2. Endpunkte und Persistenz

- **Ausführen über HTTP:** Agents in `agents/` lassen sich nur über `POST /api/control-plane/runs/:id/stream` starten. Dort wird jede Anfrage signiert geprüft (`verifyControlPlaneRequest`). Resume und Cancel liegen unter demselben Control-Plane-Präfix. Ohne Veryfront-Control-Plane gibt es keinen offenen Ausführungspfad.
- **Öffentliche Metadaten:** `GET /api/agents` und `GET /api/agents/:id` liefern ohne Auth ID, Name, Beschreibung, Avatar und Vorschläge, nie Modell, Version oder Skills. Diese Framework-Routen laufen vor unserer Auth-Middleware (T32). Deshalb bekommt der Agent eine neutrale Beschreibung ohne Konto- oder Mailbezug. T44 prüft beide Pfade im Smoke-Test.
- **MCP:** Tools in `tools/` werden nur über einen MCP-Server erreichbar, den man ausdrücklich anlegt: eine Route mit `createMCPServer({ enabled: true, auth })` oder `ai.mcp.enabled` in `veryfront.config.ts`. Das Projekt hat beides nicht. Ein Test in T41 sichert ab, dass es keine MCP-Route und keine solche Konfiguration gibt.
- **Persistenz:** Ohne `memory` hält die Instanz keinen Verlauf. `onToolResult` nennt ein „persisted or streamed back“. Das betrifft gehostete Läufe; lokal ist es nicht belegt, daher prüft der Marker-Test H12 in T42 DB, Logs und Folgeanfragen. OpenTelemetry-Tracing ist nur aktiv, wenn die OTEL-Variablen gesetzt sind; im Projekt sind sie es nicht.

## 3. Modell und Provider (O1) – STOP-8

Befund:
- Eingebaute Provider lesen ihre Zugangsdaten ausschließlich aus globalen Variablen: `OPENAI_API_KEY`/`OPENAI_BASE_URL`, `ANTHROPIC_*`, `GOOGLE_*`, `MISTRAL_*`. Einen `openrouter/*`-Provider gibt es nicht. `OPENROUTER_API_KEY` kommt nur im Integrationskatalog vor, nicht in der Modellauflösung.
- Die Doku nennt OpenRouter ausdrücklich als Beispiel für verschachtelte Modell-IDs über den OpenAI-Provider: `openai/meta-llama/llama-3.1-405b`. Mit einer Nicht-OpenAI-`OPENAI_BASE_URL` meldet sich der Provider als `openai-compatible`.
- `registerModelProvider(name, (modelId) => ModelRuntime)` ist öffentlich. Die eingebaute `OpenAIProvider`-Klasse und die Provider-Registry sind aber **nicht** exportiert. Ein eigener `openrouter`-Provider müsste also einen kompletten `ModelRuntime` selbst implementieren: Prompt-Nachrichten, Tool-Definitionen, Structured Output, Inhaltsteile, Streaming und Usage.

Optionen:

| | Weg | Neue Variablen | Code | Risiko |
|---|---|---|---|---|
| **A (Empfehlung)** | `OPENAI_API_KEY` = OpenRouter-Key, `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, Modell `openai/<anbieter>/<modell>` | 2 (STOP-6), nur in `.env.local`/Compose | keiner | Von der Veryfront-Doku gedeckt. Gilt global: Jedes `openai/*`-Modell im Prozess geht an OpenRouter, was hier gewollt ist. |
| B | Eigener `ModelRuntime` per `registerModelProvider("openrouter", …)` mit `fetch` gegen OpenRouter Chat Completions | 0 | mittel (Adapter plus Tests) | Der Runtime-Vertrag ist nur teilweise dokumentiert, z. B. die Formen der Inhaltsteile und Stream-Chunks; bei Veryfront-Updates bricht er leicht. |
| C | Kein Veryfront-Agent: Entwurf direkt über `@openrouter/sdk` mit eigenem Mini-Tool-Loop | 0 | mittel | Widerspricht O7 und D19: keine Security-Middleware, kein `evalAgent` in T43. |
| D | Veryfront Cloud Gateway (`veryfront login`) | 0 | keiner | Anderer Datenempfänger als OpenRouter; Datenschutz neu bewerten. |

Die konkrete Modell-ID (O1) wird nach der Wahl in T41 bestätigt.

### Gewählte Umsetzung (O1a, T41)

- **Option A ohne neue Pflicht-Variablen.** `lib/openrouter-env.ts` (`applyOpenRouterEnv`) setzt beim Start in `createService` (`server.ts`) `OPENAI_API_KEY` aus `OPENROUTER_API_KEY` und `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, jeweils nur wenn noch nicht gesetzt. Es überschreibt nichts und loggt keine Werte.
- **Modell:** Veryfront-String `openai/openai/gpt-6-luna` (Konstante `REPLY_DRAFTER_MODEL`), gepinnt, nicht `~openai/gpt-luna-latest`. Veryfront trennt am ersten `/`: Provider `openai`, Modell-ID `openai/gpt-6-luna` (`provider/model-registry.js`, `resolveModel`). Der OpenAI-Provider liest `OPENAI_API_KEY`/`OPENAI_BASE_URL` bei jeder Auflösung neu (`config/env.js` `getOpenAIEnvConfig`, aufgerufen in der Factory in `model-registry.js`).
- **Preis** laut OpenRouter-Modellliste: 0,10 $ pro Million Input-Token, 0,50 $ pro Million Output-Token.
- **Aufrufpfad:** `lib/draft-reply.ts` (`draftReply`): Sperre und IMAP-Refetch zuerst (`buildAgentInput`, H11), dann `agent.generate`, Rückgabe nur im Speicher. Audit `draft_generated` (Actor `system`) enthält nur Modell, Latenz und Tokenzahlen. Ohne Route; die kommt mit T42.
- **Live-Probe:** `npm run agent:probe -- --confirm-live` (`scripts/agent-live-probe.ts`), ein Aufruf mit fest eingebauter synthetischer Mail.

## 4. Datenweitergabe (Risiko aus Plan v4, Abschnitt 6)

Der Agent schickt Absenderdomain, Betreff und einen Auszug von höchstens 1200 Zeichen an den gewählten Modellanbieter. Vor T41 prüft Nico im OpenRouter-Konto die Einstellungen zu Logging/Prompt-Speicherung und zur Nutzung durch Anbieter fürs Training. Diese Einstellungen liegen im Konto, nicht im Code, und sind hier nicht prüfbar. Ob sich OpenRouters Provider-Routing (z. B. Ausschluss von Anbietern mit Datensammlung) bei Option A über `providerOptions`/Header pro Anfrage setzen lässt, ist nicht belegt und wird in T41 per Doku geprüft, bevor der Live-Aufruf läuft.

## 5. Offene Punkte

1. **O1-Umsetzung:** Option A, B, C oder D (STOP-8; bei A zusätzlich STOP-6 für zwei Variablen).
2. OpenRouter-Datenschutzeinstellungen bestätigen (Nico).
3. T41: Konfigurationstest (Abschnitt 1), MCP-Abwesenheitstest (Abschnitt 2), genau eine Live-Probe mit synthetischer Mail.
