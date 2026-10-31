# Modellvergleich: Jev gegen `openai/gpt-6-luna-decisions` (Qualität x Kosten)

Stand 2026-10-31. Live-Aufrufe nach ADR 0028, nur synthetische Inhalte. Roh-Responses und Mailtexte liegen nicht im Repo; unten stehen nur Aggregate. Die Produktion bleibt bei Jev; ein Wechsel bräuchte eine ADR und Nicos Freigabe.

## Setup

- **Modelle:** `typesafe/jev-1.13` (System One, `systemOneCreate`, wie `lib/jev.ts`) und `openai/gpt-6-luna-decisions` (OpenRouter, OpenAIs Decisions-API; Modalität text→decisions; Preis laut OpenRouter 0,0000001 USD je Prompt-Token, Completion 0). Aufgelöste Version der Probe: `openai/gpt-6-luna-decisions-20261006`, Provider `OpenAI`.
- **SDK-Befund (Context7 `/openrouterteam/typescript-sdk`, installierte Typen, ein echter synthetischer Aufruf):** `alphaDecisionsCreate` (POST `/api/alpha/decisions`) nimmt dasselbe `DecisionsRequest` wie System One (`model`, `questions`, `state`) und liefert dieselbe `DecisionsResponse` (`answers`, `model`, `provider`, `usage {inputTokens, outputTokens, cost}`). Es gibt **keinen Typunterschied**: `noul`, `choice` und `score` werden alle unterstützt und liefern dieselben Felder wie bei Jev (`noul`; `choice` mit `probabilities` und `confidence`; `score` als Erwartungswert mit `probabilities` und `legend`). Der Adapter ist deshalb minimal (`lib/decisions-client.ts`, gleiche `JevCallResult`-Form, gleiche `normalizeAnswers`). Die Metadaten melden `supported_parameters: []`; die Aufrufe liefen trotzdem ohne Zusatzparameter. `box`-Fragen (im SDK vorhanden) nutzt das Projekt nicht und wurden nicht verglichen.
- **Gleiche Fragen:** Fragenset `email-classification-v2` (`lib/jev-questions.ts`, alle neun Fragen in einem Aufruf) und die `topic`-Choice-Frage mit 16 Optionen (`lib/topics.ts`, wie `docs/insights-topics.md`). Identische Texte, Reihenfolge und State für beide Modelle; jeder Fall geht parallel an beide (gepaart). Fragenset v1 wurde nicht gelaufen (Budget).
- **Daten (alle synthetisch):** (1) `hf-v2`: 243 Fälle aus der `test`-Partition der HF-Sets `triage` und `sinabis`, geschichtet (balanced), Seed 1; (2) `fixed-v2`: das feste v2-Set (29 Fälle mit schweren Fällen und `needs_my_reply`); (3) `topics`: alle 120 Fälle von `tests/fixtures/eval/topics-synthetic.jsonl`, 16-Optionen-Variante. Jede Auswertung nutzt nur Fälle, die beide Modelle beantwortet haben (in allen Läufen: alle, 0 Fehler).
- **Aufwand:** 400 Aufrufe je Modell (392 im Hauptlauf plus 8 im Smoke-Test, dazu je ein Probeaufruf zur Formprüfung), keine Fehler. Kosten laut `usage.cost`: Jev 0,0202 USD, Luna 0,0582 USD (Luna entspricht exakt `inputTokens` x 1e-7).
- **Kennzahlen:** noul: AUC, bestes F1 (Oracle-Schwelle auf derselben Stichprobe, nur Obergrenze), F1 bei der aktuellen Jev-Schwelle (`config/noul-calibration.ts`, gilt für v1; für v2 ist nichts kalibriert), F1 und Accuracy bei 0,5, Brier. choice: Accuracy, Macro-F1. Gepaart: Übereinstimmung, Korrelation der noul-Werte, McNemar (exakt, zweiseitig) auf den uneinigen Treffern. Qualitätsindex = Mittel aus AUC (noul-Fragen mit beiden Klassen) und choice-Accuracy; Qualität je Kosten = Index / USD je 1 000 Mails.
- **Reproduzieren:** `npm run eval:fetch` und `npm run eval:compare-models -- --suite all --n 243 --topics-n 120 --seed 1 --max-calls 392` (Bericht und Tabellen nach `data/eval-runs/model-compare-*.json|md`, gitignored). Offline-Tests: `tests/model-compare.test.ts`.

## Qualität

Alle Werte gepaart (gleiche Fälle). `hf-v2`, Fragenset v2, n = 243 (Labels je Frage siehe n).

| Frage | Metrik | Jev | Luna Decisions |
| --- | --- | --- | --- |
| `is_spam` (n=162, 81 pos.) | AUC | 1,000 | 1,000 |
| | F1 bei Jev-Schwelle 0,8 | 0,818 | 0,988 |
| | F1 bei 0,5 / Accuracy bei 0,5 | 0,981 / 0,981 | 1,000 / 1,000 |
| | Brier | 0,029 | 0,005 |
| `is_phishing_or_scam` (n=162, 81 pos.) | AUC | 1,000 | 1,000 |
| | F1 bei 0,5 | 1,000 | 0,994 |
| | Brier | 0,002 | 0,005 |
| `addresses_an_ai` (n=81, 0 pos.) | Accuracy bei 0,5 | 1,000 | 1,000 |
| `category` (n=162) | Accuracy / Macro-F1 | 0,981 / 0,991 | 0,957 / 0,977 |

`fixed-v2` (29 Fälle, schwere Fälle, `needs_my_reply`, `is_assessable`): beide Modelle erreichen bei allen Fragen AUC 1,0, F1 bei 0,5 gleich 1,0 und `category` 20/20. Unterschied nur beim Brier-Wert, der bei Luna meist kleiner ist (z. B. `needs_my_reply` 0,000 gegen 0,026, `is_phishing_or_scam` 0,007 gegen 0,021). Luna gibt schärfere Werte (oft 0, 0,02, 0,98, 1) und trennt die Klassen damit klarer; Jevs Werte sind weicher.

`topics` (16 Optionen, n = 120): Accuracy 0,925 gegen 0,925, Macro-F1 0,922 gegen 0,916. Beide sind auf 108 Fällen einig (0,900); je 5 Fälle trifft nur das eine bzw. das andere Modell (McNemar p = 1,0).

Gepaarte Tests auf `hf-v2`: `is_spam` (bei 0,5) 0 Fälle nur Jev richtig, 3 nur Luna richtig (p = 0,25); `is_phishing_or_scam` 1 zu 0 (p = 1,0); `category` 5 Fälle nur Jev, 1 nur Luna (p = 0,22). **Kein Unterschied ist signifikant.** Übereinstimmung der Entscheidungen: `is_spam` 0,95, `is_phishing_or_scam` 0,99, `addresses_an_ai` 1,00, `needs_my_reply` 0,89 und `is_assessable` 0,91 (beide ohne Labels in `hf-v2`; Korrelation der Werte 0,89 bzw. 0,73), `category` 0,955.

Zur Schwelle: Jevs F1 bei der aktuellen Schwelle 0,8 liegt bei `is_spam` mit 0,818 deutlich unter dem Wert bei 0,5 (0,981). Die Schwelle ist auf Fragenset v1 kalibriert und für v2 nicht gültig; das ist ein Befund über die Kalibrierung, nicht über Jevs Trennschärfe (AUC 1,0). Luna wäre bei 0,8 weniger empfindlich, weil seine Werte schärfer liegen; auch für Luna wäre eine eigene Kalibrierung nötig.

## Kosten und Latenz

| Suite | Modell | Eingabe-/Ausgabe-Tokens (Ø) | USD je Aufruf | USD je 1 000 Mails | Latenz Ø / p95 | Qualitätsindex | Qualität je USD/1 000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hf-v2` (9 Fragen) | Jev | 1394 / 238 | 0,000059 | 0,059 | 238 / 311 ms | 0,994 | 17,0 |
| | Luna | 1920 / 0 | 0,000192 | 0,192 | 452 / 738 ms | 0,986 | 5,1 |
| `fixed-v2` | Jev | 1257 / 239 | 0,000053 | 0,053 | 222 / 273 ms | 1,000 | 18,9 |
| | Luna | 1793 / 0 | 0,000179 | 0,179 | 470 / 828 ms | 1,000 | 5,6 |
| `topics` (1 Frage) | Jev | 821 / 144 | 0,000034 | 0,034 | 221 / 296 ms | 0,925 | 26,8 |
| | Luna | 493 / 0 | 0,000049 | 0,049 | 432 / 732 ms | 0,925 | 18,8 |

- Luna kostet beim vollen v2-Set rund das **3,3-Fache** von Jev (0,19 gegen 0,06 USD je 1 000 Mails), bei der einzelnen `topic`-Frage das **1,4-Fache**. Grund: Luna rechnet nur Eingabe-Tokens ab (Ausgabe 0, 0,10 USD je Million) und zählt für die neun Fragen mehr Eingabe-Tokens (ca. 1 900 gegen 1 400); Jev berechnet Eingabe und Ausgabe.
- Luna ist rund **doppelt so langsam** (Ø 430 bis 470 ms gegen 220 bis 240 ms; p95 bis 830 ms), bei gleicher Gleichzeitigkeit 2 je Modell.
- In absoluten Zahlen sind beide billig: bei 1 000 Mails pro Tag sind es etwa 0,06 USD (Jev) gegen 0,19 USD (Luna) pro Tag.

## Empfehlung

**Jev behalten.** Die Genauigkeit ist auf diesen (leichten, synthetischen) Daten gleichwertig: kein signifikanter Unterschied, `category` leicht für Jev (0,981 gegen 0,957, p = 0,22), `topic` gleich, Spam-Trennung bei beiden perfekt. Luna kostet dabei das 1,4- bis 3,3-Fache und braucht die doppelte Latenz; die Qualität je Kosten ist bei Jev um den Faktor 1,4 bis 3,3 höher. Für einen Wechsel spricht nichts Belegtes.

Einziger konkreter Vorteil von Luna: schärfer getrennte, besser kalibrierte noul-Werte (Brier bei `is_spam` 0,005 gegen 0,029; bei `needs_my_reply` auf dem festen Set 0,000 gegen 0,026). Falls das später eine Rolle spielt (z. B. eine Aktion, die eine harte Schwelle ohne eigene Kalibrierung nutzt), wäre eine **Hybridlösung pro Frage** denkbar: Jev für `category`, `route`, `topic` und alles Übrige, Luna als zweite Meinung nur für `is_spam`/`needs_my_reply` bei Fällen nahe der Schwelle. Das lohnt erst, wenn echte Mails zeigen, dass Jevs Schwellenbereich ein Problem ist; die Mehrkosten eines zweiten Aufrufs (ca. 0,00005 bis 0,0002 USD) wären dann klein, weil er nur für Unsichere anfiele. Nicht empfohlen ohne diese Evidenz.

## Einschränkungen

- Synthetische, leichte Daten: `triage` und `sinabis` trennen Spam, Phishing und Business-Mails sehr klar (AUC 1,0 bei beiden); Unterschiede im schweren Mittelfeld (echte Newsletter, Mischmails, lange Texte) sind damit nicht messbar. Die Werte sind eher Obergrenzen. Der Test mit echten Mails ist ein Nico-Schritt.
- Stichprobengröße: 243 / 29 / 120 Fälle, ein Lauf, ein Seed, keine Wiederholung. Konfidenzintervalle breit (bei n = 120 grob ±5 Prozentpunkte); alle McNemar-Tests nicht signifikant. `addresses_an_ai` hat in `hf-v2` keine positiven Fälle, `needs_my_reply` und `is_assessable` dort keine Labels (nur Übereinstimmung gemessen); die Labels dieser Fragen kommen nur aus dem kleinen festen Set.
- Das beste F1 nutzt die Schwelle der Stichprobe selbst und ist nur eine Obergrenze. Schwellen für v2 sind weder für Jev noch für Luna kalibriert.
- `topic` wurde wie in der Probe einzeln gefragt, nicht zusammen mit den neun anderen Fragen (v3 existiert nicht); Kosten und Qualität im Verbund sind offen.
- Kosten laut `usage.cost` (Jev) bzw. Preisliste (Luna: Eingabe-Tokens x 1e-7, vom Aufruf bestätigt). Preise und Modellversion (`...-20261006`) können sich ändern; die Decisions-API ist `alpha`.
- Latenz mit je zwei parallelen Aufrufen pro Modell und einem zweiten Agenten, der parallel Jev-Evals fährt; nur Größenordnung.
