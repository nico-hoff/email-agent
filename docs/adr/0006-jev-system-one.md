# 0006 Jev über System One, versionierte Fragensets

- Status: angenommen
- Datum: 2026-10-20
- Bezug: `docs/jev-contract.md`, `lib/jev.ts`, `lib/jev-questions.ts`, `lib/jev-response.ts`, `@openrouter/sdk`

## Kontext
Klassifikation soll strukturierte Wahrscheinlichkeiten liefern, nicht Freitext. Jev (`typesafe/jev-1.13`) beantwortet feste Ja/Nein- und Choice-Fragen mit Scores.

## Entscheidung
Jev nur über `@openrouter/sdk` System One, **kein** Chat-Agent. Fragensets sind versioniert (v1 Standard, v2 bereit, unkalibriert); die Version wird pro Klassifikation gespeichert. SDK-Felder nur nach Context7 → installierten Typen → synthetischer Fixture, nie aus dem Gedächtnis.

## Folgen
- Neue Fragen = neues Fragenset + Eval + Kalibrierung, nicht stilles Ändern.
- Live-Aufrufe (`jev:probe*`, `eval:jev`) nur auf Nicos Anweisung, mit synthetischem Inhalt.
