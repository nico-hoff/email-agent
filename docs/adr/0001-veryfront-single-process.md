# 0001 Veryfront, ein Prozess

- Status: angenommen
- Datum: 2026-10-20
- Bezug: `docs/IMPLEMENTATION_PLAN.md`, `server.ts`, `AGENTS.md`

## Kontext
Ein Nutzer, ein Rechner (Mac/Pi/eine fly-Machine). Benötigt werden UI, API, Hintergrund-Worker (IMAP-Abruf, Klassifikation) und LLM-Agenten. Veryfront bietet Seiten, Routen, Agenten und Tools in einem TypeScript-Projekt.

## Entscheidung
Ein einziger Node-Prozess: `server.ts` startet Veryfront (`startServer`) und im selben Prozess den IMAP-Worker. Keine Queue, kein separater Dienst, kein Container-Verbund. Ordnerkonventionen nach `AGENTS.md` (`app/`, `agents/`, `tools/`, …); Logik liegt rein und testbar in `lib/`.

## Folgen
- Einfacher Betrieb, eine SQLite-Datei, keine Netzwerk-Grenzen intern.
- Genau **eine** Instanz darf laufen (SQLite, In-Memory-Limits, Worker). Horizontal skalieren geht nicht und ist nicht nötig.
- Veryfront-Eigenheiten wirken direkt auf uns (siehe 0011, CSS-Scanner in `lib/dev-hazards.ts`).
