# Themen-Probe (R8, ADR 0026): wie viele Optionen unterscheidet Jev?

Stand 2026-10-31. Live-Probe nach ADR 0028, nur synthetische Inhalte. Roh-Responses liegen nicht im Repo; unten stehen nur Aggregate.

## Methode

- **Frage:** eine Choice-Frage `topic` (`typesafe/jev-1.13`, `@openrouter/sdk` System One, genau wie `lib/jev.ts`: `questions: { topic: { type: "choice", instructions, criteria } }`, Antwort `answers.topic.choice` plus `probabilities`). Die Optionen kommen aus `lib/topics.ts` (12 feste Themen aus ADR 0026 mit stabilen Schlüsseln, bis zu 8 eigene Themen, Listenversion = Hash der normalisierten Liste). Die Kriterientexte sind Englisch (wie die anderen Fragensets), die deutschen Labels sind nur für die App.
- **Daten:** `tests/fixtures/eval/topics-synthetic.jsonl`, handgeschrieben, 120 Mails (DE/EN gemischt, Domains `*.example.test`): je 8 pro festes Thema (96) plus je 6 für vier Beispiel-Eigenthemen (Segelverein, Hausbau, Steuerberater, Auto). Die HF-Sets wurden bewusst nicht gemappt: ihre Kategorien sind Triage-Klassen (`travel`, `finance` ...) ohne eindeutiges Alltagsthema und liegen im Worktree nicht vor.
- **Varianten:** 6, 9, 12 und 16 Optionen (Teilmengen der festen Themen in Häufigkeitsreihenfolge, `Sonstiges` immer dabei; 16 = 12 feste + 4 eigene) und zweistufig (Stufe 1: 12 feste Themen, deren `Sonstiges` auch Spezialinteressen auffängt; nur bei Antwort `Sonstiges` Stufe 2 mit den 4 eigenen Themen plus `Sonstiges`).
- **Stichprobe:** `--n 96 --seed 1`, nach Thema geschichtet, für alle Varianten dieselben 96 Fälle. Zusätzlich 16 Optionen auf allen 120 Fällen (`--seed 2`).
- **Kennzahlen:** *In-Set* = Fälle, deren erwartetes Thema in der Optionsliste ist; Accuracy und Macro-F1 nur dort. *Abstain* = Anteil der In-Set-Fälle (ohne Sonstiges), die als `Sonstiges` beantwortet wurden. *Außerhalb* = Anteil der Fälle ohne passende Option, die bei `Sonstiges` landen. Latenz, Kosten aus `usage.cost`.
- **Aufwand:** 610 Jev-Aufrufe, Kosten zusammen ca. 0,019 USD (ca. 0,00003 USD pro Aufruf), keine Fehler.

## Ergebnisse

| Variante | In-Set | Accuracy | Macro-F1 | Abstain | Außerhalb → Sonstiges | mittl. Top-p | Latenz Ø / p95 | USD / Aufruf |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 Optionen | 36 | 0,944 | 0,941 | 0,000 | 0,533 (60) | 0,894 | 236 / 486 ms | 0,000023 |
| 9 Optionen | 54 | 0,944 | 0,937 | 0,000 | 0,500 (42) | 0,901 | 222 / 360 ms | 0,000026 |
| 12 Optionen | 72 | 0,958 | 0,953 | 0,000 | 0,083 (24) | 0,930 | 206 / 273 ms | 0,000030 |
| 16 Optionen (n=96) | 96 | 0,927 | 0,922 | 0,000 | n/a | 0,918 | 213 / 296 ms | 0,000034 |
| 16 Optionen (n=120) | 120 | 0,917 | 0,911 | 0,000 | n/a | 0,927 | 209 / 296 ms | 0,000035 |
| zweistufig (n=96, 102 Aufrufe) | 96 | 0,750 | 0,679 | 0,000 | n/a | 0,948 | 220 / 371 ms | 0,000030 |

Häufigste Verwechslungen (16 Optionen): `Steuerberater` → Finanzen (2), `Hausbau` → Behörden/Verträge, `Segelverein` → Vereine/Hobbys (je 1), sonst fast nur Fälle des Fixtures `Sonstiges` → Einkäufe/Reisen/Arbeit. Zweistufig: `Segelverein` → Vereine (6 von 6), `Steuerberater` → Finanzen (6 von 6), `Hausbau` und `Auto` verteilt auf Wohnen/Arbeit/Behörden.

## Auswertung

1. **Die Optionsanzahl ist bis 16 kein Engpass.** Von 6 auf 12 Optionen ändert sich nichts Messbares (0,94 bis 0,96, im Rauschen einer Stichprobe von 36 bis 72 Fällen), bei 16 sinkt die Accuracy auf 0,92. Der Rückgang kommt aus den Eigenthemen, nicht aus der Zahl: Sie überlappen inhaltlich mit festen Themen (Steuerberater/Finanzen, Segelverein/Vereine, Hausbau/Wohnen), und Jev wählt dann oft das feste, breitere Thema. Bei den festen Themen allein blieb es bei 12 Optionen bei 0,96.
2. **`Sonstiges` wird kaum als Ausweg benutzt** (Abstain 0 in allen Varianten). Jev wählt lieber das nächstliegende Thema; für die 3 bis 4 bewusst vagen `Sonstiges`-Fälle des Fixtures heißt das: sie landen bei Einkäufen/Reisen/Arbeit. Das ist ein Fixture- und Erwartungsthema (einige dieser Fälle sind tatsächlich zuordenbar, z. B. ein Paket), kein Fehler der Optionsanzahl.
3. **Zweistufig ist klar schlechter** (0,75 gegenüber 0,92). Stufe 1 sortiert Eigenthemen-Mails in das nächste feste Thema ein, bevor Stufe 2 sie sieht, und nur 6 von 96 Mails kamen überhaupt in Stufe 2. Ohne Degradation bei 12+ Optionen gibt es keinen Grund dafür; die Variante wird nicht empfohlen.
4. **Zuverlässigkeit der Wahrscheinlichkeiten:** `probabilities` enthält jede Option (Summe 1); mittlere Top-Wahrscheinlichkeit 0,89 bis 0,95. Der Zusammenhang zwischen Top-p und Treffer wurde hier nicht ausgewertet (offen).

## Empfehlung

- **Einstufig mit allen Optionen** (12 feste + bis zu 4 eigene = 16 getestet). Bis 16 Optionen kostet das keine messbare Zuverlässigkeit bei den festen Themen; Eigenthemen erkennt Jev, wenn sie sich vom nächsten festen Thema abgrenzen.
- **Grenze für eigene Themen:** `MAX_CUSTOM_TOPICS` in `lib/topics.ts` steht auf 8; getestet sind nur 4. Empfehlung: UI zunächst auf 4 begrenzen, bis ein Lauf mit 8 vorliegt.
- **Eigenthemen brauchen einen kurzen Hinweis (`hint`)**, der sie vom nächsten festen Thema abgrenzt (z. B. „Steuerberater: Mails der eigenen Steuerkanzlei, nicht Bank oder Versicherung“). Ohne Hinweis ist das Kriterium nur „Mails zum Thema <Label>“.
- **Kein Zwei-Stufen-Verfahren**, keine Zusatzkosten: ein Aufruf bleibt bei ca. 0,00003 bis 0,00004 USD (`topic` im selben Aufruf wie die übrigen Fragen wurde hier nicht gemessen).

## Eval v3 mit vollem Fragenset (R8, ADR 0037)

Stand 2026-11-01. Live-Eval nach ADR 0028, nur synthetische Inhalte; nur Aggregate, keine Mailtexte, keine Roh-Responses. Werkzeug: `npm run eval:topics -- --hf-n jev=90,luna-decisions=32 --topics-n 120 --write-gate` (`scripts/topics-eval.ts`).

**Methode.** Je Modell zwei Teile. (1) HF-`test`-Split (`triage` + `sinabis`, Seed 7, balanciert, n Fälle), jeder Fall zweimal gefragt: mit dem v2-Fragenset und mit dem **vollen v3-Fragenset** (v2 plus `topic`), gepaart, gleiche Fälle. Gemessen wird, ob `topic` im selben Aufruf die noul-Antworten verschiebt: F1 bei der Schwelle der jeweiligen Kalibrierung (v3-Schwellen = v2-Schwellen). (2) Das Themen-Fixture `tests/fixtures/eval/topics-synthetic.jsonl` (alle 120 Fälle) mit dem **vollen v3-Fragenset** und der größten gemessenen Liste (12 feste + 4 eigene Themen = 16 Optionen); das war bisher nur mit der Einzelfrage gemessen. Die Daten des Laufs (IDs, erwartete Werte, Themenschlüssel, noul-Zahlen) liegen als Gate-Datensatz in `evals/datasets/topics-v3__jev.jsonl` und `…__luna-decisions.jsonl`.

**Aufwand.** 484 Aufrufe (Budget 500), keine Fehler: Jev 300 Aufrufe (2 x 90 HF + 120 Thema), ca. 0,021 USD (ca. 0,00007 je Aufruf, Mittel 231 ms); Luna Decisions 184 Aufrufe (2 x 32 HF + 120 Thema), ca. 0,040 USD (ca. 0,00022 je Aufruf, Mittel 451 ms). Zusammen ca. 0,061 USD.

| Modell | Thema Genauigkeit | Thema Macro-F1 | `is_spam` F1 v2 / v3 | `is_phishing_or_scam` F1 v2 / v3 | `needs_my_reply` F1 v2 / v3 | gepaarte HF-Fälle |
| --- | --- | --- | --- | --- | --- | --- |
| Jev (`typesafe/jev-1.13`) | 0,933 | 0,929 | 0,909 / 0,941 (n=36, 18 pos.) | 1,000 / 1,000 (n=36, 18 pos.) | 0,684 / 0,684 (n=72, 27 pos.) | 90 |
| Luna Decisions | 0,925 | 0,916 | 1,000 / 1,000 (n=13, 7 pos.) | 1,000 / 1,000 (n=13, 7 pos.) | 0,692 / 0,692 (n=26, 9 pos.) | 32 |

`addresses_an_ai`: auf HF keine positiven Fälle, nicht bewertbar (wie in der Kalibrierung v2). `is_assessable` ist unkalibriert.

**Verwechslungen im Themen-Fixture** (erwartet -> Antwort; nur Schlüssel). Jev: `custom_steuerberater` -> `finance` (2), `custom_hausbau` -> `official`, `custom_segelverein` -> `clubs`, `family` -> `newsletter`, drei Fälle des Fixtures `other` -> `shopping`/`travel`/`official`. Luna: `custom_segelverein` -> `clubs` (2) und -> `education`, `custom_steuerberater` -> `finance`, `clubs` -> `health`, vier Fälle `other` -> `family` (2)/`newsletter`/`travel`. Wie in der Probe: Eigenthemen, die sich inhaltlich mit einem festen Thema überlappen, verliert gegen das breitere feste Thema; die `other`-Fälle des Fixtures sind teils zuordenbar.

**Einordnung.**
1. **`topic` im vollen Fragenset kostet nichts Messbares.** Jev erreicht mit allen Fragen im selben Aufruf 0,933 / 0,929 (Einzelfrage in der Probe: 0,917 / 0,911 auf denselben 120 Fällen, innerhalb des Rauschens). Die noul-F1-Werte sind bei Jev gleich oder besser als v2 (`is_spam` 0,941 gegen 0,909 ist ein Fall mehr richtig, kein Beleg für eine Verbesserung).
2. **Luna ist bei Themen ähnlich gut** (0,925 / 0,916), kostet aber etwa das Dreifache je Aufruf und braucht doppelt so lange.
3. **Die noul-Schwellen von v3 bleiben die von v2**, je Modell (Kalibrierung v3 in `docs/jev-contract.md`, Einträge 4 und 5 in `config/noul-calibration.ts`).
4. **Aussagekraft.** Bei Jev 90 gepaarte Fälle, bei Luna nur 32 (Budget): Luna ist für die noul-Stabilität nur grob gestützt. Die Stichprobe ist eine Teilmenge des `test`-Splits von R7 (andere Größe, deshalb sind die v2-F1-Werte nicht mit `docs/insights.md` vergleichbar). Das Fixture ist klein und sauber geschrieben (Obergrenze, siehe unten).

### Eval grün (Gate)

Je Modell, offline über die gespeicherten Antworten (`lib/topics-gate.ts`, Konstanten `TOPICS_GATE`):
1. Themen-Genauigkeit >= 0,85 **und** Macro-F1 >= 0,85 auf dem Themen-Fixture mit dem vollen v3-Fragenset, mindestens 100 Fälle.
2. noul: mindestens 30 gepaarte HF-Fälle; für jede Frage mit >= 5 positiven Fällen (mindestens zwei solche Fragen) ist F1 von v3 bei der v3-Schwelle höchstens 0,02 schlechter als F1 von v2 bei der v2-Schwelle.

Stand: **Jev grün** (0,933 / 0,929; keine noul-Verschlechterung), **Luna grün** (0,925 / 0,916; wie Jev, bei kleiner Stichprobe). Prüfung: `npm run eval` (Beispiele `topics-v3:topics-v3__jev` und `…__luna-decisions`) und `tests/topics-gate.test.ts`. Ein nicht grünes Gate lässt `npm run eval` und den Test fehlschlagen. Das UI-Angebot des Schalters („Themen“ im Profil) darf erst erscheinen, wenn beides grün ist; `topics_enabled` bleibt bis dahin aus.

## Offene Punkte

- Fixture ist klein und sauber geschrieben (kurze, eindeutige Mails). Echte Mails (lange Texte, Mischthemen) sind schwerer; Genauigkeit ist eher eine Obergrenze. Der Test mit echten Mails ist ein Nico-Schritt.
- Die `Sonstiges`-Fälle des Fixtures sind teils mehrdeutig; vor einem Kalibrierlauf überarbeiten oder getrennt auswerten.
- Top-p als Abstain-Schwelle (unterhalb → `Sonstiges`/unsicher) nicht untersucht; dazu Trefferquote je Top-p-Band messen.
- ~~`topic` zusammen mit den übrigen v2-Fragen in einem Aufruf~~ gemessen in „Eval v3 mit vollem Fragenset“ (R8): kein messbarer Einfluss auf die noul-Antworten; Kosten ca. 0,00007 USD je Aufruf bei Jev.
- Luna nur mit 32 gepaarten HF-Fällen gemessen; vor einem Verlass auf Luna + Themen ein größerer Lauf (z. B. 90 Fälle, ca. 180 Aufrufe).
- Eigenthemen mit 8 Stück und mit absichtlich ähnlichen Labels (z. B. „Segeln“ und „Segelverein“) sind nicht getestet.
- Wiederholbarkeit: ein Lauf je Variante (plus ein zweiter Seed bei 16 Optionen, dort 0,927 und 0,917); Konfidenzintervalle bei n=36 bis 96 sind breit (grob ±5 Prozentpunkte).

Reproduzieren: `npm run jev:probe:topics -- --confirm-live --options 6,9,12,16,two-stage --n 96 --seed 1` (Bericht nach `data/eval-runs/`, gitignored).
