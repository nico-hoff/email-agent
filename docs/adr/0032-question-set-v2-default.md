# 0032 Fragenset v2 ist das Standard-Fragenset, Schwellen je Fragenset-Version

- Status: angenommen
- Datum: 2026-10-31
- Bezug: R7, ändert 0007 (v2 „bleibt ohne Aktionen“), 0006, 0014, 0028; `docs/insights.md`, `docs/jev-contract.md` (Abschnitt „Kalibrierung v2“), `config/noul-calibration.ts`

## Kontext
Fragenset v2 (T26) schärft `needs_my_reply` und grenzt in `is_phishing_or_scam` legitime Sicherheitsmails ab. Es war nicht kalibriert; alle noul-Antworten blieben `unmapped`. ADR 0028 erlaubt Live-Proben mit synthetischen Inhalten. R7 hat v2 mit 783 Aufrufen auf den öffentlichen HF-Sets gemessen (Schwellen nur auf `calib`, Bericht auf `test`, `docs/insights.md`).

## Entscheidung
- `config/noul-calibration.ts` ist eine Liste mit einem Eintrag je Fragenset-Version. Eintrag „1“ (v1) bleibt unverändert, neu ist Eintrag „2“ (v2, 2026-10-31): `is_spam` 0.70, `is_phishing_or_scam` 0.70, `addresses_an_ai` 0.30, `needs_my_reply` 0.50. `is_assessable` bleibt ohne Schwelle. Die Lesart folgt der Version der jeweiligen Klassifikation; eine unbekannte oder fehlende Version, oder eine Frage ohne Schwelle, bleibt `unmapped` (fail-closed). Ein Test hält jede Tabelle in `docs/jev-contract.md` mit der Konfiguration synchron.
- `QUESTION_SET_VERSION` (`lib/constants.ts`) wechselt von v1 auf v2. Kriterium war: v2 ist auf `test` bei `is_spam` und `is_phishing_or_scam` mindestens so gut wie v1 (F1 0.889 gegen 0.806 und 1.000 gegen 0.988, jeweils Precision 1.0 beim Spam), und nichts in der Pipeline bricht (Verbraucher geprüft: Pipeline, Shadow, Postfach-Aktionen, Absender-HITL, `email-api`, Agent-Eingang, Sample, Dev-DB, Evals, e2e-Smoke; alle lesen die Version je Klassifikation).
- Alte v1-Klassifikationen bleiben gespeichert und behalten ihre v1-Lesart (Schwellen 0.80/0.50/0.30). Es gibt keine automatische Neuklassifikation; neue Mails werden mit v2 gefragt, die Eindeutigkeit je Mail, Fragenset und Modell bleibt erhalten.
- `needs_my_reply` wird mit Recall-Vorrang kalibriert (0.50), obwohl die Trennung nur gegen Betrugs- und Werbemails sauber ist (siehe Folgen).

## Folgen
- Die `is_spam`-Schwelle sinkt gegenüber v1 von 0.80 auf 0.70. Die HF-Negative sind zu leicht, um das nach unten abzusichern; die Evidenz zu echten Negativen stammt aus dem kleinen v1-Sample. Auto-Aktionen schaltet weiterhin nur Nico scharf (0025); vor dem Scharfschalten ein echtes v2-Sample prüfen (`docs/qa/R7.md`).
- Die Anzeige „Offen“ und der Entwurfsknopf hängen an `needs_my_reply` positiv und erscheinen jetzt für v2-Mails. Gegen die lockere Etikettierung beträgt die Precision nur etwa 0.5 (`forward`/`flag` zählen für Jev als Anfrage); mehr Mails gelten als offen. Nur Anzeige, keine Postfachaktion.
- Shadow-Kandidaten bleiben aus, weil `is_assessable` ohne Schwelle bleibt. D15 (`security_auth` nie Kandidat) und die Agent-Sperre D18 (`addresses_an_ai` 0.30) gelten unverändert.
- `eval:jev` fragt ohne `--question-set` jetzt v2; `--question-set v1` ruft das eingefrorene v1 weiter auf. Das Offline-Gate (`npm run eval`) bekommt eine v2-Basis (`email-eval-v2__qs-v2.jsonl`, 29 echte Antworten).
- Eine Schwellenänderung ist weiterhin ein Commit mit Eval-Beleg (`insights.md`) und neuer Versionsnummer im Eintrag.
