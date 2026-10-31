# 0029 Veryfront bleibt; eigene Tool-Schicht mit Gate; Hooks nur für Audit und Tracing

- Status: angenommen
- Datum: 2026-10-31
- Bezug: Framework-Eval 2026-10-31 (Anthropic Agent SDK, OpenAI Agents SDK, Vercel AI SDK, Strands, LangGraph, Langdock, Hermes, Veryfront), `docs/veryfront-guide.md`, 0001, 0010

## Kontext
Wir nutzen weder Veryfront Cloud noch dessen Inferenz. Die Eval ergab: Die Agenten-Schleife ist bei allen SDKs austauschbar. Unterschiede liegen bei Gate-Semantik, Persistenz beim Pausieren, Telemetrie-Standard und Modellbindung. Veryfront hat **keinen** Hook vor einem einzelnen Tool-Aufruf und keine Tool-Freigabe ohne Cloud/Studio (`tool()` hat keine Approval-Option, Agent-`middleware` umschließt den ganzen Durchlauf, `onToolCall` beobachtet nur, `onToolResult` läuft danach). Unsere Kopplung an Veryfront ist klein (≈ 50 Zeilen direkte API, ≈ 7.000 von 8.150 Zeilen in `lib/` frameworkfrei); teuer wäre ein Wechsel vor allem bei UI und Evals.

## Entscheidung
1. **Veryfront bleibt** für Seiten, Routen, Build, Agenten-Hülle und Evals. Kein SDK-Wechsel jetzt; bei Bedarf ist Vercel AI SDK 7 der Favorit für die Agenten-Schicht (Gate mit `denied`/`user-approval`, zustandslos, Telemetrie aus, Langfuse-Integration).
2. **Tools sind unsere:** Kern in `lib/` als reine Funktion `execute(ctx, input) → typisiertes Ergebnis` mit Schema; `tools/<id>.ts` ist nur die dünne Veryfront-Hülle.
3. **Gate in der Hülle, vor der Logik:** `allow` → ausführen; `deny` → typisiertes `{ ok: false, code }` ans Modell; `ask` → „wartet auf Freigabe“, die Freigabe läuft im App-Ablauf (nicht im Tool). Timeout/Fehler = `deny`. Vorbild: `get-email-context` (Eligibility-Gate vor der Allowlist).
4. **Tool-Rückgabe ist eine Datengrenze:** nur Metadaten nach Allowlist, Fehler als Ergebnis, nie ganze Mails.
5. **Explizite Tool-Listen pro Agent, nie `tools: true`** (würde den ganzen Katalog über `veryfront__tool_search` freigeben).
6. **Hooks gezielt:** `onToolResult` für Audit/Langfuse-Spans mit Metadaten; Agent-`middleware` für Tracing, Rate-Limit, Kosten pro Nutzer. Langfuse nur mit Metadaten (IDs, Scores, Entscheidung, Tokens, Dauer); Maskierung ist Sicherheitsnetz, ein Test schlägt fehl, wenn synthetischer Mailtext in einem Span landet.
7. **Agent nur, wo das Modell entscheidet.** Klassifikation (Jev) und Zusammenfassen ohne Tools sind einzelne Aufrufe.
8. **Die Standard-Security-Middleware** (aktiv, solange `security` nicht `false` ist) wird vor R2 mit synthetischen Mails geprüft und dann bewusst konfiguriert oder ersetzt.

## Folgen
- Ein späterer SDK-Wechsel tauscht nur die Hüllen in `tools/` und `agents/`.
- Bausteine-Nutzung und Fallstricke stehen in `docs/veryfront-guide.md`.
