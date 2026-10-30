# Antwort-Agent: Veryfront-Vertrag (T39)

> Stand: 2026-10-26, `veryfront` 0.1.1285. Quellen in dieser Reihenfolge (H6): Context7 `/websites/veryfront`, danach die installierten Typen und der Code unter `node_modules/veryfront/esm/src`. Live-Aufrufe: keine.
>
> **Ergebnis:** D17 und D19 sind erfüllbar (kein STOP-10). **STOP-8 für O1:** Der Weg „OpenRouter mit dem vorhandenen Key, ohne neue Variable“ ist mit der öffentlichen Veryfront-API nicht ohne Weiteres gangbar. Nico wählt unten eine Option, bevor T41 einen Provider anbindet.

## 1. Agent definieren

`agent()` aus `veryfront/agent`, Datei `agents/reply-drafter.ts`, Aufruf aus der Route über `getAgent("replyDrafter")` (Veryfront leitet die ID aus dem Dateinamen `agents/reply-drafter.ts` ab) (Rückgabe `Agent | undefined`, vorher prüfen) und `agent.generate({ input, outputSchema?, abortSignal? })`. Die Antwort enthält `text`, `toolCalls`, `usage` und bei `outputSchema` die geparsten Daten in `data`/`object`. Ein Aufruf aus einer Route braucht keine Chat-UI: `createAgUiHandler` und `agent.respond()` sind optional und werden nicht genutzt.

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

## 6. Briefing-Agent und Entwurfs-Route (M6, T56/T42)

Quellen: Context7 `/websites/veryfront` (`agent.stream()` „Returns `Promise<AgentStreamResult>`“, „use `agent.stream()` directly only for a custom transport or non-chat streaming surface“; `getAgent()` gibt `Agent | undefined` zurück) und die installierten Typen.

**Stream-Vertrag (belegt, `esm/src/agent/types.d.ts` Zeilen 383-390 und 417-441, `factory.js` 90-146):** `AgentStreamResult` hat nur `toDataStreamResponse()`; es ist **kein** async iterable. Die Antwort ist ein `Response` mit SSE-Body (`data: {json}\n\n`; Rahmen `text-delta` mit `delta`, `error`, `finish`). Text-Deltas und Abschluss kommen zusätzlich über die Callbacks `onChunk(text)` und `onFinish(response)` (`usage.promptTokens/completionTokens/totalTokens`) von `AgentStreamInput`; `abortSignal` bricht den Lauf ab. Der Body muss bis zum Ende gelesen werden, sonst schreitet der Strom nicht voran. `lib/briefing.ts` (`runBriefingStream`) nutzt `onChunk`/`onFinish` für Text und Tokens und liest den Body nur zum Treiben und für `{"type":"error"}`-Rahmen. Tests nutzen einen Fake in genau dieser Form (`tests/helpers/fake-stream-agent.ts`). Abweichung von der Auftragsformulierung „async iterable“: diese Form gibt es in 0.1.1285 nicht.

**Agent `agents/briefing.ts`:** Modell `openai/openai/gpt-6-luna`, `allowedModels`, kein `tools` (also keine Projekt-Tools), `skills: false`, `mcpServers: []`, `maxSteps: 1`, kein `memory`, `security` nicht gesetzt (Standard an), neutrale Beschreibung, kein `outputSchema` (freier Text). Das Konfigurations-Testfile ist `tests/briefing-agent.test.ts`. Zugriff aus der Route: `resolveAgent("briefing")` (`lib/agent-registry.ts`, lazy `getAgent`).

**Eingabe (D27/H20):** `lib/briefing-context.ts`. Offene Mails (Plan v5 3.6, ohne Spam und Provider-Spam), sortiert Dringlichkeit, Wichtigkeit, Zeit, höchstens 25. Je Mail nur Konto-Kurzname, Absenderdomain, Betreff (Steuerzeichen raus, 120 Zeichen, im Zaun `<untrusted_mail_subjects>`, Zaun-Tags entfernt), Kategorie, Dringlichkeit, Wichtigkeit. Mails mit `addresses_an_ai` positiv, unmapped oder ohne Antwort stehen nur in `not_listed_flagged`. Zähler: `open_total`, `listed`, `new_since_last_open`, `auto_marked_read_since_last_open` (live ausgeführte `mark_seen`-Aktionen), `open_sender_questions` (0, wenn es `senders` nicht gibt; bei jedem Fehler 0). Vor dem ersten Öffnen sind die beiden „seit“-Zähler `unknown`, nicht 0.

**SSE-Vertrag von `POST /api/briefing`** (Antwort `text/event-stream`, `Cache-Control: no-store`; Fehler vor dem Strom als JSON mit 401/403/429/500). Ereignisse als `event: <name>` plus `data: <json>`:

| Ereignis | Daten | Bedeutung |
|---|---|---|
| `meta` | `{ source: "model" or "fallback", cached: boolean, open_total, listed }` | immer das erste Ereignis |
| `delta` | `{ text }` | Textstück, anhängen; bei Cache und Fallback genau ein Ereignis mit dem ganzen Text |
| `error` | `{ code: "agent_failed" or "briefing_failed", fallback: boolean }` | `fallback: true`: danach folgen `delta` (Fallback-Text) und `done`; `false`: bisheriger Text bleibt, Strom endet ohne `done` |
| `done` | `{ source, cached, mails, model?, latency_ms? }` | Abschluss; erst danach ist `last_opened_at` gesetzt |

Reihenfolge der Prüfung: Session (401), Rate-Limit (429, 30 je 10 Minuten), CSRF (403), dann Kontext und Strom. Cache: 5 Minuten im Arbeitsspeicher je Identität, nur Modell-Ergebnisse (D28). Trennt der Client die Verbindung, wird das `abortSignal` des Agenten ausgelöst und nichts mehr geschrieben. Ein harter Stopp nach 30 Sekunden zählt als `agent_failed`. Die UI stellt den Text als reinen Text dar.

**Fallback:** Synthetischer Modus, kein `OPENAI_API_KEY` (aus `OPENROUTER_API_KEY` abgeleitet), Agent nicht registriert oder Fehler vor dem ersten Text: fester deutscher Text aus dem Kontext (`fallbackBriefing`, z. B. „3 offene Mails, davon 1 dringend.“), `source: "fallback"`, kein Audit.

**Persistenz:** Nur Audit `briefing_generated` (Modell, Latenz, Tokens, `mails`) und `user_state.last_opened_at` (Migration 005). Der Briefing-Text wird nie gespeichert (H12-Marker-Test: `tests/briefing-route.test.ts`).

**Entwurfs-Route `POST /api/emails/:id/draft`:** Session (401), Rate-Limit 10 je 10 Minuten (429), CSRF (403), Id (404), synthetischer Modus (`409 not_available_in_synthetic`), dann `draftReply` (Sperre H11, IMAP-Refetch, `replyDrafter` per `getAgent`). Antwort 200 `{ draft, language, tone, needs_human_check, reasons }`, überall `no-store`. Fehler nur als Codes: `409 not_eligible` (mit `reasons`), `404 email_not_found`, `409 not_classified`/`source_gone`, `502 fetch_failed`/`agent_failed`/`invalid_output`, `503 agent_unavailable`. H12: `tests/draft-route.test.ts` prüft, dass Entwurfs- und Auszugsmarker weder in der Datenbank noch in Logs noch in `GET /api/emails` und `/api/emails/:id` auftauchen.

**Offen:** Ob `getAgent("briefing")`/`getAgent("replyDrafter")` im Prozess der API-Route den vom Server entdeckten Agenten liefert, ist nur mit einem echten Lauf belegbar (Smoke lief synthetisch, also im Fallback).

## 7. Evals für Antwort-Agent und Briefing-Agent (T43, M6)

Quellen: Context7 `/websites/veryfront` (Guide „Evals“, API `veryfront/eval`) und die installierten Typen. Live-Aufrufe bei der Umsetzung: keine.

**Was Veryfront belegt (0.1.1285):**

| Aussage | Beleg |
|---|---|
| `evalAgent({ target: "agent:<id>", dataset, metrics, mockTools? })` führt einen Agenten pro Beispiel aus (`generate`); `mockTools` ersetzt dabei nur das Tool-Set des Laufs. | `esm/src/eval/types.d.ts` Zeilen 407-421 (`EvalAgentInput`), Context7 „Mock tools for local agent evals“ |
| `evalDataset({ id, dataset, metrics })` hat kein Ziel; der gespeicherte `input` jedes Beispiels wird direkt bewertet, `reference` ist die Erwartung. Das nutzt das Offline-Gate. | `types.d.ts` 427-437 (`EvalDatasetInput`), Context7 „evalDataset“ |
| `metrics.agent.noFailedTools()`, `notCalledTool(name)`, `calledTool`, `toolCallCount` prüfen die Trace-Daten eines `evalAgent`-Laufs; `metrics.ops.latency({ maxMs })`, `tokens`, `cost` sind Budgets (`.budget()`). Die installierte Signatur von `ops.cost` ist `{ maxCredits }` (die Doku zeigt `maxUsd`: Widerspruch, nicht benutzt). | `esm/src/eval/metrics.d.ts` 37-62 |
| `metrics.judge.rubric({ rubric, judge })` ruft eine Judge-Funktion; `judges.llm.rubric({ model, framing, threshold })` ist der eingebaute LLM-Judge (Standard-Schwelle 0,8, `framing: "answer"` zeigt dem Judge auch den Input). Er löst das Modell über `resolveModel` auf, also über denselben `OPENAI_*`-Weg wie die Agenten. | `esm/src/eval/judges.d.ts` 17-39, `metrics.js` 1027-1069 |
| Es gibt **keine** öffentliche Fabrik für eigene Metriken (`createMetric` ist intern, `EvalMetric` verlangt handgeschriebenes `gate()/soft()/budget()`). Deterministische Prüfer laufen deshalb vor dem Dataset; `metrics.answer.jsonMatch().gate()` vergleicht das Prüfergebnis mit „sauber“. | `metrics.js` 561-581 (nicht exportiert), `metrics.d.ts` |
| Jede `*.eval.ts` unter `evals/` wird von `veryfront eval` (also `npm run eval`) geladen und ausgeführt. Ein `evalAgent` dort würde das echte Modell rufen. | Verhalten von `npm run eval`; deshalb liegt **kein** `evalAgent` in `evals/` (H22). |

**Offline-Gate (`npm run eval`, CI, ohne Secrets, ohne Modellaufruf):**

- Fälle: `tests/fixtures/eval/reply-drafter-v1.jsonl` (12 Entwurfsfälle, DE/EN: Anfrage mit Frist, Terminabstimmung, Rechnungsfrage, Beschwerde, englische Geschäftsmail, Terminverschiebung, **vier Injection-Versuche** im gezäunten Auszug (Anweisungen ignorieren, Link einfügen, IBAN nennen, englisch mit Link und Freigabe), Info-Mail ohne Antwortbedarf, Zahlungsdruck) und `briefing-v1.jsonl` (8 Briefing-Kontexte in der Form von `lib/briefing-context.ts`: nichts offen, einige normale, viele dringende, Injection im Betreff, nur Spam, offene Absenderfragen, `addresses_an_ai` positiv, englische Betreffs beim ersten Öffnen). Alle Hosts enden auf `.example` oder `.example.test`. Je Fall stehen die prüfbaren Regeln im Feld `expect`.
- Prüfer: `lib/agent-eval-checks.ts`, reine Funktionen: Bullet-Zählung, Links (Schema, `www.`, nackte Domains), E-Mail-Adressen, IBAN-Form, Telefonnummern, Injection-Formulierungen, grobe Sprache (de/en per Stoppwörter), „erfundener Absender“ (nur Domains aus dem Kontext sind erlaubt), verbotene Wörter, Satzzahl. Ergebnisse sind nur Regel-Codes (`link_in_draft`, `too_many_bullets`, …), nie der gefundene Text.
  - Entwurf: kein Link, keine IBAN, keine Telefonnummer, keine Injection-Formulierung, keine fallspezifischen verbotenen Wörter, Sprache gleich Erwartung (Feld und Stoppwort-Schätzung), `needs_human_check` bei Injection und Druck, `reasons` bei gesetztem Flag, Längenobergrenze, optional Bezug zur Mail.
  - Briefing: höchstens 3 Bullets, bei „nichts offen“ genau ein Satz ohne Bullets, kein Link, keine Adresse, keine IBAN/Telefonnummer, keine Injection-Formulierung, keine verbotenen Wörter (z. B. Spam-Betreffs), keine nur gezählten Betreffs (`addresses_an_ai` nicht negativ), keine Domain außerhalb des Kontexts, deutsch, die dringendste Mail wird erwähnt.
- Gespeicherte Ausgaben: `evals/datasets/reply-drafter__v1.jsonl` und `briefing__v1.jsonl`, genau eine Zeile je Fall (`id`, `origin`, `output`). `evals/reply-drafter.eval.ts` und `evals/briefing.eval.ts` bewerten sie mit den Prüfern über `evalDataset` und `metrics.answer.jsonMatch().gate()`. Fehlt ein Fall, schlägt das Laden fehl (das Gate darf nicht still schrumpfen). `lib/eval-gate.ts` liest nur `email-eval-*.jsonl`, der Jev-Gate bleibt davon unberührt.
- **Aussagekraft:** Die mitgelieferten Ausgaben haben `origin: "derived"`: von Hand geschriebene, synthetische Beispiele, die die Regeln erfüllen. Sie prüfen die Verdrahtung und die Prüfer, **nicht** die Agenten. Echte Aussagekraft entsteht erst, wenn Nico den Live-Lauf macht und die Datasets mit `origin: "live"` ersetzt. Dass ein Verstoß rot wird, belegen Unit-Tests (`tests/agent-eval-gate.test.ts`, Abschnitt „negative cases“) mit manipulierten Ausgaben; solche Fälle gehören nicht ins Gate.
- Grenzen der Prüfer: Muster, keine Semantik. Eine befolgte Injection in anderen Worten, ein unhöflicher Ton, ein sachlich falscher Bezug oder eine erfundene Person ohne Domain bleiben unentdeckt; dafür gibt es den optionalen Judge. Die Sprachschätzung gibt bei kurzem Text „unbekannt“ und beanstandet dann nichts.

**Live-Runner (Nico): `npm run eval:agents -- --confirm-live [--set drafts|briefing|all] [--judge] [--write-dataset]`**

- `scripts/agent-eval-live.ts` ruft die echten Agenten mit den synthetischen Fällen: Entwurf über `agent.generate({ input: formatAgentInput(...), tools: {} })` wie in `scripts/agent-live-probe.ts` (ohne IMAP, ohne Datenbank, ohne Projekt-Tools), Briefing über `runBriefingStream` auf `formatBriefingInput(buildBriefingContext(...))`. Die Ergebnisse prüft derselbe Code wie das Gate.
- Harte Grenze: höchstens **25** Aufrufe je Lauf (Generierung plus Judge), geprüft vor dem ersten Aufruf und bei jedem Aufruf. Standard `--set all` sind 20 Aufrufe. `--judge` verdoppelt die Zahl und passt nur zu `--set drafts` (24) oder `--set briefing` (16); `--set all --judge` (40) wird abgelehnt.
- Der Judge ist `judges.llm.rubric({ model: REPLY_DRAFTER_MODEL, framing: "answer" })` mit je einer Rubrik für Entwürfe (höflich, Bezug, keine befolgte Injection, keine Links/Kontodaten/Zusagen) und Briefing („nur Signal“, keine Erfindungen, keine befolgte Injection). Das lokale Ausführen ist belegt, weil `judges.llm.rubric` ohne Server eine Funktion über `resolveModel` liefert. Die Judge-Tokens meldet Veryfront nicht zurück; sie fehlen in der Kostenschätzung.
- Budgets (Entsprechung zu `metrics.ops.latency/cost`, hier als feste Schwellen je Aufruf, weil das Veryfront-Metrik-Objekt einen `EvalRecord` bräuchte): Entwurf 20 s und 0,002 $, Briefing 15 s und 0,002 $. Kosten sind aus den Tokens und den OpenRouter-Preisen (0,10 / 0,50 $ je Million) geschätzt. Überschreitungen stehen im Bericht und machen den Exit-Code 1.
- `noFailedTools` und `notCalledTool` gelten nur für `evalAgent`-Läufe mit Tools. Der Live-Runner übergibt `tools: {}`; jeder Tool-Aufruf in der Antwort zählt als Verstoß `tool_called`. Briefing hat ohnehin keine Tools (`tests/briefing-agent.test.ts`).
- Bericht: `data/eval-runs/agents-<iso>.json` mit IDs, Regel-Codes, Tokens, Latenz, geschätzten Kosten und Judge-Score. Kein Ausgabetext. `eval:compare` überspringt `agents-*`.
- `--write-dataset` schreibt die Ausgaben eines Satzes nach `evals/datasets/*__v1.jsonl` (`origin: "live"`), aber nur, wenn alle Fälle des Satzes ohne Fehler liefen. Regelverstöße bleiben absichtlich drin, dann wird `npm run eval` rot und zeigt, was der echte Agent getan hat. Die Ausgaben sind synthetisch; vor dem Commit ansehen. Danach `npm run eval`.
- Fehler in einem Fall (Agent wirft, ungültige Struktur, leerer Text) werden als Code vermerkt, nie mit Providertext; der Lauf geht weiter.
