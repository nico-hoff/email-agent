# 0041 Klassifikationsmodell (System One) pro Nutzer wählbar

- Status: angenommen
- Datum: 2026-10-31
- Bezug: Wunsch Nico 2026-10-31, 0006, 0007, 0022, 0032, `docs/insights-models.md`, `lib/decisions-client.ts`

## Kontext
Der Modellvergleich (`docs/insights-models.md`) zeigt: `openai/gpt-6-luna-decisions` (OpenRouter, Decisions-API) nimmt dieselben Fragen wie Jev (`typesafe/jev-1.13`, System One), liefert gleiche Qualität auf synthetischen Daten, schärfer kalibrierte Wahrscheinlichkeiten, kostet aber das 1,4- bis 3,3-Fache und ist etwa doppelt so langsam. Nico will, dass Nutzer ihr System-One-Modell in den Einstellungen selbst wählen; langfristig als Premium-Funktion.

## Entscheidung
- Einstellung pro Nutzer (Profil → Einstellungen): Klassifikationsmodell aus einer **festen Allowlist** im Code (`typesafe/jev-1.13` = Standard, `openai/gpt-6-luna-decisions`). Freitext-Modelle gibt es nicht.
- Die Pipeline wählt den Client pro Konto nach dem Modell seines Nutzers (Jev: `systemOneCreate`, Decisions: `alphaDecisionsCreate`, gleiche Fragen, gleiche Normalisierung). `classifications.model_requested` hält das Modell schon heute fest; ein Modellwechsel klassifiziert nichts rückwirkend neu.
- **Schwellen gelten je Fragenset und Modell.** `config/noul-calibration.ts` bekommt das Modell als Schlüssel; ein Modell ohne Kalibrierung liest alle noul-Antworten als `unmapped` (fail-closed): keine Spam-Aktion, keine Agent-Freigabe über `addresses_an_ai`. Ein Modell erscheint erst in der Auswahl, wenn es für das Standard-Fragenset kalibriert ist (Eval auf `calib`, Bericht auf `test`, wie 0007/0032).
- **Premium vorbereitet, nicht gebaut:** Die Auswahl steht hinter einer Berechtigung pro Nutzer (`classifier_choice`), die heute nur ein Admin setzt. Abrechnung, Preise und Pläne kommen mit dem go2market-Gate.
- Kosten bleiben sichtbar: die Einstellung zeigt den relativen Preis je 1 000 Mails aus dem letzten Vergleichslauf.

## Folgen
- Umsetzung in R3 (Profil-Einstellungen), nach R1 (Nutzerkonten). Kalibrierung für Luna Decisions auf v2 als eigener Eval-Lauf (synthetisch, ADR 0028).
- Evals und das Offline-Gate prüfen jedes wählbare Modell.
- Ein späterer weiterer Anbieter ist nur ein neuer Allowlist-Eintrag plus Kalibrierung.
