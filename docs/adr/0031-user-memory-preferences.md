# 0031 Nutzer-Gedächtnis: Präferenzen lernen (add/search), nicht Veryfront Knowledge

- Status: angenommen
- Datum: 2026-10-31
- Bezug: Wunsch Nico 2026-10-31, 0004, 0022, 0029

## Kontext
Der Agent eines Nutzers soll Präferenzen lernen und nutzen („antwortet Behörden formell“, „Newsletter von X immer aussortieren“, „duzt Kollegin Y“). Veryfront Knowledge passt nicht: Es indexiert **versionierte Projektdateien** aus `knowledge/` in eine lokale JSON-Datei (`data/knowledge-index.json`) oder Veryfront Cloud (`RagStoreBackend = "auto" | "local-json" | "veryfront-cloud"`), ist projektweit statt pro Nutzer und hat kein Schreib-Tool (nur Suche). `node:sqlite` bringt Volltextsuche (FTS5) und JSON mit und kann Erweiterungen laden (`allowExtension`, z. B. `sqlite-vec` für Vektorsuche).

## Entscheidung
- Tabelle `user_memories` (pro `user_id`: `text` ≤ 280 Zeichen, `kind` (`preference|rule|fact_about_me`), `source` (`agent|user`), `created_at`, `last_used_at`, `status`) plus FTS5-Index.
- Agent-Tools `add_memory` und `search_memory` (Kern in `lib/`, dünne Hülle nach 0029). `search_memory` liefert Top-k nur des eigenen Nutzers.
- **Gate auf `add_memory`:** Text muss eine Aussage über den Nutzer bzw. seine Wünsche sein; keine Zitate aus Mails, keine personenbezogenen Daten Dritter außer Rolle/Domain, keine Secrets/Zahlungsdaten; Längen- und Tageslimit; Duplikat-Erkennung. Umsetzung: deterministische Prüfungen + Jev-Fragen (z. B. „Ist das eine Präferenz des Nutzers?“, „Enthält es personenbezogene Daten Dritter?“) mit kalibrierten Schwellen, fail-closed.
- UI: Profil → „Was der Agent über mich weiß“: ansehen, bearbeiten, löschen, Lernen aus/an.
- Vektorsuche (`sqlite-vec` + Embeddings) erst, wenn FTS5 messbar nicht reicht (Eval).

## Folgen
- Gedächtnis ist abgeleitetes Wissen, keine Mailinhalte; Export/Löschung gehört zum go2market-Gate.
- Veryfront Knowledge bleibt für eventuelle statische Hilfetexte (z. B. FAQ) reserviert.
