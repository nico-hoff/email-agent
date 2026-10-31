# 0010 Agenten-Sicherheit: Gate, Metadaten-Briefing, Entwürfe ungespeichert

- Status: angenommen
- Datum: 2026-10-30
- Bezug: `docs/agent-contract.md` §1–§7, `lib/briefing.ts`, `app/api/emails/[id]/draft`

## Kontext
LLM-Agenten sehen Nutzerdaten und könnten durch Mailinhalte manipuliert werden (Prompt Injection).

## Entscheidung
- **Entwurf** nur auf Knopfdruck, nur für Mails, die das Eligibility-Gate passieren (kein Spam/Phishing, kein `security_auth`, `addresses_an_ai` unter Schwelle). Ergebnis wird angezeigt, nie gespeichert, nie gesendet.
- **Briefing** bekommt nur Metadaten offener Mails (Absender, Kategorie, Dringlichkeit, Alter), keinen Inhalt; SSE-Stream; ohne KI ein deterministischer Fallback.
- Agenten haben keine Tools mit Schreibwirkung.

## Folgen
- Agent nicht erreichbar → Briefing-Fallback, Entwurf `503 agent_unavailable`.
- Agenten-Evals (`npm run eval`, offline) prüfen Gate und Format; Live-Evals nur durch Nico.
