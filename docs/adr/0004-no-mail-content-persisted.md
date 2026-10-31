# 0004 Keine Mailinhalte speichern, nur synthetische Fixtures

- Status: angenommen
- Datum: 2026-10-20
- Bezug: H1/H3 in `docs/IMPLEMENTATION_PLAN.md`, `docs/erd.md`, `docs/jev-contract.md`

## Kontext
Die App liest private Postfächer. Ein DB-Leck, Logs, Fixtures oder ein Screenshot dürfen keine Mailinhalte preisgeben.

## Entscheidung
Persistiert werden nur Metadaten (Absender, Betreff-unabhängige Kennungen laut ERD, Zeitstempel, Klassifikations-Scores, Status). **Nie** gespeichert oder geloggt: Body, Auszug, Rohquelle, Anhänge, Jev-Roh-Response, Agenten-Entwürfe. Inhalte existieren nur flüchtig im Speicher während Klassifikation bzw. Entwurf. Testdaten und Eval-Datensets sind synthetisch (HF-Datensets, eigene Fixtures).

## Folgen
- Detailansicht holt den Inhalt bei Bedarf live per IMAP (lesend).
- Fehlermeldungen geben nur Fehlerklasse/-code aus, keine Stacktraces mit Pfaden oder Inhalten.
- graphify nur im Code-Modus; `.graphifyignore` schließt `data/` aus.
