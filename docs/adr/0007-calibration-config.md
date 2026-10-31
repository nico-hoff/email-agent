# 0007 Kalibrierung als versionierte Konfiguration, ungemappt = fail-closed

- Status: angenommen
- Datum: 2026-10-27
- Bezug: `config/noul-calibration.ts`, `npm run calibrate`, `docs/eval-datasets.md`

## Kontext
Jev-Scores sind nicht automatisch Entscheidungsschwellen. Schwellen müssen messbar begründet und nachvollziehbar sein.

## Entscheidung
Schwellen pro Fragenset in `config/noul-calibration.ts` (v1: `is_spam` 0.80, `is_phishing_or_scam` 0.50, `addresses_an_ai` 0.30). Fragen ohne Schwelle (`needs_my_reply`, `is_assessable`) lösen **keine** Aktion aus. Schwellen stammen aus dem calib-Split, gemessen wird auf dem test-Split.

## Folgen
- Schwellenänderung = Commit mit Eval-Beleg (`insights.md`).
- Fragenset v2 bleibt ohne Aktionen, bis Nico T25b (Kalibrierung v2) gemacht hat.
