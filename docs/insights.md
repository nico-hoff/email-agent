# Insights: Kalibrierung v2 (R7)

Stand 2026-10-31. Auswertung der Live-Evals für Fragenset v2 (und v1 zum Vergleich) auf den öffentlichen synthetischen HF-Sets. Nur Aggregate: keine Mailtexte, keine Roh-Responses (ADR 0004/0028). Werkzeug: `scripts/calibration-report.ts` (liest `data/eval-runs/`, lokal, nicht committet); die Läufe selbst entstehen mit `scripts/eval-jev.ts`. Beschlossene Schwellen: `docs/jev-contract.md`, Abschnitt „Kalibrierung v2“, und `config/noul-calibration.ts` (Eintrag „2“).

## Kurzfassung

- Schwellen v2 (gewählt nur auf `calib`): `is_spam` 0.70, `is_phishing_or_scam` 0.70, `addresses_an_ai` 0.30 (von v1), `needs_my_reply` 0.50 (neu). `is_assessable` bleibt `unmapped`.
- Auf `test` ist v2 bei `is_spam` und `is_phishing_or_scam` mindestens so gut wie v1 (jeweils mit den Schwellen der eigenen Version): `is_spam` F1 0.889 gegen 0.806 (beide Precision 1.0), `is_phishing_or_scam` F1 1.000 gegen 0.988.
- `needs_my_reply`: v2 trennt Antwort-Fälle klar von Betrugsmails (AUC 1.00 in der strengen Sicht) und im festen Set, aber nicht von Mails, die der Datensatz mit `forward`/`flag` etikettiert. v1 trennt gar nicht (AUC 0.53 calib, 0.70 test; fast jede Mail ~0.98).
- Das Standard-Fragenset wird auf v2 umgestellt (ADR 0032).
- 783 Jev-Aufrufe, ca. 0.042 USD.

## Datenbasis

| Quelle | Revision (Commit-SHA, Stand Abruf 2026-10-31) | Zeilen | Dubletten | Lizenz |
|---|---|---|---|---|
| `triage` (`weijianzhg/email-triage-action-seed`) | `8c98baa8b10a1dddd676c860d9e1b86c89141c38` | 3 905 | 0 | Apache-2.0 |
| `sinabis` (`sinabis-group/sinabis-1k-synthetic-emails`) | `cb5225000e9afc08dbca839f7ecd768178be4ba8` | 1 010 | 0 | CC BY 4.0 |

Aufteilung (fest, nach Inhalts-Hash, `docs/eval-datasets.md`): `calib` 1 486 Fälle, `test` 3 429 Fälle (zusammen alle 4 915 Zeilen). Mit der neuen Etikettierung von `needs_my_reply` aus der Spalte `action` (siehe unten) sind alle Zeilen beider Quellen geladen; vorher waren es 2 331.

Stichprobe: Seed 7, Strategie `balanced`, Schichten Quelle × Klasse. Alle vier Läufe (v1/v2 × calib/test) ziehen **dieselben Fälle**, weil die Stichprobe nicht vom Fragenset abhängt.

| Split | n | Schichten (je) | Schicht, Anzahl in der Population |
|---|---|---|---|
| `calib` | 150 | 30 | `sinabis\|business` 315, `triage\|no_reply_expected` 486, `triage\|personal` 243, `triage\|phishing` 151, `triage\|reply_expected` 291 |
| `test` | 200 | 40 | wie oben, Populationen: 695, 1 134, 578, 349, 673 |

Die Läufe auf `calib` und `test` überlappen nicht (disjunkte Partitionen). Zusätzlich: ein Lauf mit Seed 11, n 24 (`test`) nur für die synthetische Dev-DB und den Screenshot (keine Auswertung), und das feste Set v2 (29 Fälle) für v1 und v2.

### Etiketten

| Frage | Positive | Negative |
|---|---|---|
| `is_spam` | `triage\|phishing` (Betrug zählt als unerwünscht) | `sinabis` (legitime Geschäftsmails) |
| `is_phishing_or_scam` | `triage\|phishing` | `sinabis` |
| `addresses_an_ai` | keine | `sinabis` |
| `needs_my_reply` | `triage` mit `action = reply` | `triage` mit `action` `ignore`, `forward`, `flag` |
| `category` | `personal`, `business` | (Mehrklassen) |

Wichtig für die Einordnung: Die HF-Sets haben **keine harten Negative** für Spam (kein Newsletter, keine legitime Werbung; `triage` enthält trotz der Dataset-Beschreibung keine `spam`-/`newsletter`-Kategorie). Die Negative sind leichte Fälle (`is_spam` max 0.08 auf calib). Die Precision ist deshalb auf diesen Daten fast immer 1.0 und begrenzt die Schwelle nicht; das ist die wichtigste Grenze der Auswertung (siehe „Offene Punkte“). Außerdem gibt es kein positives Beispiel für `addresses_an_ai` auf HF.

## Verteilung der Rohwerte (v2, Quantile je Klasse)

| Frage | Split | Klasse | n | min | p10 | Median | p90 | max |
|---|---|---|---|---|---|---|---|---|
| `is_spam` | calib | positiv | 30 | 0.11 | 0.73 | 0.87 | 0.94 | 0.96 |
| `is_spam` | calib | negativ | 30 | 0.02 | 0.02 | 0.03 | 0.06 | 0.08 |
| `is_spam` | test | positiv | 40 | 0.46 | 0.60 | 0.88 | 0.95 | 0.98 |
| `is_spam` | test | negativ | 40 | 0.02 | 0.02 | 0.03 | 0.06 | 0.19 |
| `is_phishing_or_scam` | calib | positiv | 30 | 0.97 | 0.97 | 0.98 | 0.99 | 0.99 |
| `is_phishing_or_scam` | calib | negativ | 30 | 0.02 | 0.03 | 0.04 | 0.10 | 0.57 |
| `is_phishing_or_scam` | test | positiv | 40 | 0.84 | 0.97 | 0.98 | 0.99 | 0.99 |
| `is_phishing_or_scam` | test | negativ | 40 | 0.02 | 0.03 | 0.04 | 0.13 | 0.66 |
| `addresses_an_ai` | calib | negativ | 30 | 0.01 | 0.02 | 0.02 | 0.02 | 0.02 |
| `addresses_an_ai` | test | negativ | 40 | 0.01 | 0.02 | 0.02 | 0.03 | 0.05 |

Der Rohwert ist ein Grad für `true`: bei klaren Fällen nahe 0 oder nahe 1, Zwischenwerte nur bei Mehrdeutigem. Die wenigen niedrigen positiven `is_spam`-Werte (0.11 calib, 0.46 test) sind Betrugsmails, die Jev als Phishing, aber nicht als Spam sieht; die Etikettierung `phishing => is_spam` ist dort fragwürdig und drückt den Recall.

## Schwellenwahl nur auf `calib`

Regeln (je Frage, vor dem Blick auf `test` festgelegt, ADR 0007: Precision vor Recall):

- `is_spam`: höchste Schwelle mit Precision 1.0 und Recall >= 0.90 auf calib. Zusätzlich muss sie über dem Maximum der echten INBOX-Mails des v1-Samples (0.65, gleicher Fragetext) liegen.
- `is_phishing_or_scam`: größter negativer Wert auf calib plus 0.10 (aufgerundet auf 0.05).
- `addresses_an_ai`: von v1 übernommen (Fragetext unverändert, bewusst niedrig für die Agent-Sperre D18); auf HF keine positiven Beispiele, daher nicht neu wählbar.
- `needs_my_reply`: Recall zuerst (ein übersehenes „braucht Antwort“ ist teurer als ein überflüssiges): kleinster positiver Wert auf calib (0.60) minus 0.10, auf 0.05 gerundet.

### Schwellentabelle calib, v2 (Auszug)

`is_spam` (n 60: 30 positiv, 30 negativ, AUC 1.000):

| Schwelle | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| 0.50 | 29 | 0 | 1 | 30 | 1.000 | 0.967 | 0.983 |
| 0.60 | 28 | 0 | 2 | 30 | 1.000 | 0.933 | 0.966 |
| **0.70** | 27 | 0 | 3 | 30 | 1.000 | 0.900 | 0.947 |
| 0.80 | 19 | 0 | 11 | 30 | 1.000 | 0.633 | 0.776 |
| 0.90 | 12 | 0 | 18 | 30 | 1.000 | 0.400 | 0.571 |

`is_phishing_or_scam` (n 60: 30/30, AUC 1.000):

| Schwelle | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| 0.50 | 30 | 1 | 0 | 29 | 0.968 | 1.000 | 0.984 |
| 0.60 | 30 | 0 | 0 | 30 | 1.000 | 1.000 | 1.000 |
| **0.70** | 30 | 0 | 0 | 30 | 1.000 | 1.000 | 1.000 |
| 0.90 | 30 | 0 | 0 | 30 | 1.000 | 1.000 | 1.000 |

`needs_my_reply` (n 120: 48 positiv, 72 negativ in der lockeren Etikettierung, AUC 0.777):

| Schwelle | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|
| 0.40 | 48 | 43 | 0 | 29 | 0.527 | 1.000 | 0.691 |
| **0.50** | 48 | 43 | 0 | 29 | 0.527 | 1.000 | 0.691 |
| 0.60 | 48 | 36 | 0 | 36 | 0.571 | 1.000 | 0.727 |
| 0.70 | 40 | 26 | 8 | 46 | 0.606 | 0.833 | 0.702 |
| 0.80 | 18 | 14 | 30 | 58 | 0.563 | 0.375 | 0.450 |

Warum 0.70 statt 0.50 bei `is_spam`: Auf HF ist die Precision bei jeder Schwelle 1.0, die HF-Negative sind zu leicht, um eine niedrigere Schwelle zu stützen. Die einzige Evidenz zu schwierigeren echten Negativen (v1-Sample, 6 INBOX-Mails bis 0.65) liegt knapp darunter; 0.70 ist der höchste Wert, der noch 90 % Recall auf calib hält. Die Schwelle ist damit gegenüber v1 (0.80) gesenkt; die Folge für Auto-Aktionen steht unter „Offene Punkte“.

Warum 0.70 bei `is_phishing_or_scam` (v1: 0.50): Auf calib und test gibt es je einen negativen Fall bei 0.57 bzw. 0.66 (False Positive bei 0.50; test zusätzlich bei 0.60), die positiven Fälle liegen bei >= 0.84 (test) bzw. >= 0.97 (calib). 0.70 hat Abstand zu beiden Seiten.

Warum 0.50 bei `needs_my_reply`: kleinster positiver calib-Wert 0.60; Abstand 0.10. Das feste Set v2 stützt die Lage (positiv >= 0.79, negativ <= 0.33), ist aber nicht unabhängig (die v2-Formulierung wurde an diesen Fällen entworfen).

## Ergebnis auf `test` (mit den Schwellen der jeweiligen Version)

n 200 Aufrufe je Version, 0 Fehler. Frage-Stichproben: `is_spam`/`is_phishing_or_scam` n 80 (40/40), `addresses_an_ai` n 40 (nur negativ), `needs_my_reply` n 160 (55 positiv, 105 negativ, locker), `category` n 80.

| Frage | Version, Schwelle | TP | FP | FN | TN | Precision | Recall | F1 | AUC |
|---|---|---|---|---|---|---|---|---|---|
| `is_spam` | v2, 0.70 | 32 | 0 | 8 | 40 | 1.000 | 0.800 | 0.889 | 1.000 |
| `is_spam` | v1, 0.80 | 27 | 0 | 13 | 40 | 1.000 | 0.675 | 0.806 | 1.000 |
| `is_spam` | v2, 0.80 (zum Vergleich) | 28 | 0 | 12 | 40 | 1.000 | 0.700 | 0.824 | 1.000 |
| `is_phishing_or_scam` | v2, 0.70 | 40 | 0 | 0 | 40 | 1.000 | 1.000 | 1.000 | 1.000 |
| `is_phishing_or_scam` | v1, 0.50 | 40 | 1 | 0 | 39 | 0.976 | 1.000 | 0.988 | 1.000 |
| `addresses_an_ai` | v2, 0.30 | 0 | 0 | 0 | 40 | - | - | - | - |
| `addresses_an_ai` | v1, 0.30 | 0 | 0 | 0 | 40 | - | - | - | - |
| `needs_my_reply` (locker) | v2, 0.50 | 54 | 56 | 1 | 49 | 0.491 | 0.982 | 0.655 | 0.735 |
| `needs_my_reply` (locker) | v1, 0.50 | 55 | 103 | 0 | 2 | 0.348 | 1.000 | 0.516 | 0.701 |
| `needs_my_reply` (streng) | v2, 0.50 | 54 | 0 | 1 | 40 | 1.000 | 0.982 | 0.991 | 1.000 |
| `needs_my_reply` (streng) | v1, 0.50 | 55 | 40 | 0 | 0 | 0.579 | 1.000 | 0.733 | 0.474 |

`category`: Accuracy 0.975 (78 von 80) bei v1 und v2 (Macro-F1 0.658 wegen sehr kleiner Klassen), auf calib 1.000 (60/60). Gleich in beiden Versionen, also keine Veränderung durch die Umformulierung.

Zur Einordnung der Intervalle: Bei n 40 je Klasse ist ein Recall von 0.80 mit einem 95-%-Wilson-Intervall von ca. 0.65 bis 0.90 behaftet (Precision 1.0 bei 32 TP: untere Grenze ca. 0.89). Die Unterschiede v1 gegen v2 bei `is_spam` (0.675 gegen 0.80 Recall) liegen innerhalb dieser Bandbreite und kommen im Wesentlichen aus den unterschiedlichen Schwellen, nicht aus anderen Rohwerten: bei gleicher Schwelle 0.80 sind beide praktisch gleich (v2 28 TP, v1 27 TP). Die Fragenformulierung von `is_spam` ist in v2 unverändert; die kleine Streuung ist Modellrauschen.

## `needs_my_reply` im Detail

Die Etiketten kommen aus der Spalte `action` von `triage` (Mapper, `docs/eval-datasets.md`): `reply` => true; `ignore`, `forward`, `flag` => false. Median des Rohwerts je Kategorie und Aktion (calib + test, v2; v1 ist dort überall ~0.97 bis 0.99):

| Kategorie / Aktion | Median v2 (calib) | Median v2 (test) | Median v1 (beide) |
|---|---|---|---|
| `phishing` / `ignore` | 0.11 | 0.13 | 0.98 |
| `personal` / `reply` | 0.81 | 0.77 | 0.97 bis 0.98 |
| `finance` / `reply` | 0.77 | 0.80 | 0.98 |
| `meeting_request` / `reply` | 0.72 | 0.75 | 0.99 |
| `customer_support` / `reply` | 0.73 | 0.82 | 0.98 |
| `personal` / `forward` | 0.80 | 0.78 | 0.94 bis 0.97 |
| `customer_support` / `forward` | 0.70 | 0.73 | 0.97 bis 0.98 |
| `meeting_request` / `flag` | 0.71 | 0.75 | 0.98 |
| `finance` / `flag` | 0.80 | 0.79 | 0.97 |
| `travel` / `flag` | 0.84 | 0.74 | 0.96 bis 0.98 |

Befund: v2 hat die erhoffte Wirkung (die v1-Probe gab 0.83 für Werbung ohne Rückfrage, die v2-Probe 0.04; Betrugsmails ~0.13 statt ~0.98). Es unterscheidet aber „richtet eine Anfrage an mich“ von „keine Anfrage“, nicht „antworten“ von „weiterleiten/markieren“. Mails mit Aktion `forward`/`flag` enthalten für Jev ebenfalls eine Anfrage und erhalten ~0.75. Die Triage-Aktion ist hier keine Wahrheit für „braucht meine Antwort“; die lockere Sicht (Precision 0.53 calib, 0.49 test) unterschätzt v2, die strenge (nur `reply` gegen `ignore`; n 78 calib, 95 test) überschätzt es, weil die Negative nur Betrugsmails sind. Realistisch liegt die Qualität dazwischen.

Festes Set v2 (29 Fälle, davon 17 mit Erwartung für `needs_my_reply`: 4 positiv, 13 negativ): v2 positiv >= 0.79, negativ <= 0.33, 17 von 17 richtig bei 0.5; v1: positiv >= 0.98, negativ bis 0.98, 8 von 17 richtig (9 der 13 negativen Fälle, darunter Newsletter mit „Antworten Sie jetzt“, liest v1 als „braucht Antwort“). Das Set ist die Entwurfsgrundlage von v2 und daher kein unabhängiger Beleg.

Entscheidung: `needs_my_reply` bekommt in v2 die Schwelle 0.50, weil ein übersehenes „braucht Antwort“ teurer ist als ein überflüssiges und die Folgen keine Postfachaktion sind (nur Anzeige „Offen“ und Entwurfsknopf). Die Qualität ist mittelmäßig; Nico sollte das in der QA an echten Mails beurteilen (`docs/qa/R7.md`).

## v1 gegen v2 (Zusammenfassung)

| Aspekt | v1 | v2 |
|---|---|---|
| `is_spam` test F1 (eigene Schwelle) | 0.806 | 0.889 |
| `is_phishing_or_scam` test F1 (eigene Schwelle) | 0.988 (1 FP) | 1.000 |
| `needs_my_reply` Trennung (AUC test, locker) | 0.701 | 0.735 |
| `needs_my_reply` Werbemail mit „Antworten Sie jetzt“ (Fixture) | 0.83 | 0.04 |
| `needs_my_reply` festes Set 17 Erwartungen | 8 richtig | 17 richtig |
| `category` test Accuracy | 0.975 | 0.975 |
| Kosten je Aufruf (Mittel, HF) | ca. 0.000050 | ca. 0.000057 |

Bei `is_phishing_or_scam` liegt der Unterschied an der Schwelle (0.50 gegen 0.70), nicht an der neuen Formulierung: die Verteilung der negativen Rohwerte ist praktisch gleich (calib max 0.53 v1, 0.57 v2; test max 0.61 gegen 0.66). Der Effekt der „legitime Sicherheitsmails“-Klausel ließ sich auf HF nicht messen: HF enthält keine Login-Code-/Passwort-Reset-Mails. Er zeigt sich nur im festen Set v2 (alle Phishing-Erwartungen 21 von 21 bei beiden Versionen, Auswertung bei 0.5).

## Kosten und Aufrufe

| Lauf | Aufrufe | Kosten (USD) |
|---|---|---|
| Probe v2 (Fixture) | 1 | 0.000055 |
| calib v2 | 150 | 0.008586 |
| calib v1 | 150 | 0.007515 |
| test v2 | 200 | 0.011487 |
| test v1 | 200 | 0.010059 |
| Festes Set v2, Fragenset v2 | 29 | 0.001531 |
| Festes Set v2, Fragenset v1 | 29 | 0.001324 |
| Dev-DB-Lauf (Seed 11, n 24, Screenshot) | 24 | 0.001388 |
| **Summe** | **783** | **0.041945** |

Fehler: 0 in allen Läufen. Alle Aufrufe mit synthetischem Inhalt (HF-Sets, eingebaute Fixtures); modellgemeldete Version `typesafe/jev-1.13-20260917`.

## Offene Punkte

1. **Keine harten Negative für Spam auf HF.** Newsletter, legitime Werbung und Transaktionsmails fehlen als Negative; die `is_spam`-Schwelle 0.70 ist daher durch HF nicht nach unten abgesichert und stützt sich auf das kleine echte v1-Sample (6 INBOX-Mails). Empfehlung: Nico lässt vor dem scharfen Schalten der Auto-Aktion ein echtes Sample (`npm run sample`, danach `npm run calibrate -- --question-set email-classification-v2`) bewerten. Gegenüber v1 (0.80) sinkt die Schwelle; Auto-Aktionen schaltet nur Nico scharf.
2. **`needs_my_reply` ist nur ein Anfrage-Signal.** Die Triage-Aktion `forward`/`flag` wird von Jev nicht von `reply` getrennt; mehr Mails erscheinen als „Offen“ (im synthetischen Dev-Lauf 21 von 24). Mögliche Verbesserung: eine zusätzliche Frage „Muss ich selbst antworten?“ oder das Gewicht über `route` (`draft_reply`) kombinieren. Kein Teil von R7.
3. **`addresses_an_ai` ohne positive Fälle auf HF.** Nur das feste Set v2 hat 3 (alle >= 0.99); die Schwelle 0.30 bleibt aus v1 übernommen.
4. **`is_assessable` bleibt `unmapped`.** Keine Labels (im festen Set 2 negative Fälle), damit bleiben Shadow-Kandidaten aus.
5. **Etikettierung `phishing => is_spam`** ist fragwürdig; sie senkt den gemessenen Recall bei `is_spam` (einzelne Betrugsmails 0.11 bis 0.46).
6. **Mittelwert-Scores.** `urgency` und `importance` sind Erwartungswerte (z. B. 2.38 aus 0.2/0.02/0.78) und nur mit `probabilities` lesbar; nicht kalibriert.
7. Die gepoolten Intervalle sind breit (n 30 bis 40 je Klasse); die Aussage „v2 mindestens so gut wie v1“ gilt für die Punktschätzer, nicht statistisch gesichert.
