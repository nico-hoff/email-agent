# 0009 Agenten über OpenRouter mit `OPENAI_*`-Ableitung

- Status: angenommen
- Datum: 2026-10-30
- Bezug: `lib/openrouter-env.ts`, `agents/reply-drafter.ts`, `agents/briefing.ts`, `docs/agent-contract.md`

## Kontext
Veryfront-Agenten sprechen einen OpenAI-kompatiblen Provider an. Es soll nur ein Schlüssel (`OPENROUTER_API_KEY`) nötig sein.

## Entscheidung
Modell `openai/gpt-6-luna` über OpenRouter; in Veryfront als `openai/openai/gpt-6-luna` (Provider-Präfix + Modell-ID, `lib/constants.ts`). `applyOpenRouterEnv` setzt `OPENAI_API_KEY`/`OPENAI_BASE_URL` aus `OPENROUTER_API_KEY` **nur**, wenn kein eigener `OPENAI_API_KEY` gesetzt ist; die Base-URL wird nur zusammen mit dem abgeleiteten Schlüssel gesetzt (sonst ginge ein OpenAI-Schlüssel an OpenRouter).

## Folgen
- Ein echter `OPENAI_API_KEY` hat Vorrang und geht direkt an OpenAI.
- Agenten-ID folgt dem Dateinamen (`replyDrafter`, `briefing`).
- OpenRouter-Datenschutz (Logging/Training aus) prüft Nico im Konto.
