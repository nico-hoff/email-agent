# Öffentliche synthetische Eval-Datensets

Zweck: wiederholbare Jev-Evals (`npm run eval:jev -- --source hf ...`) auf öffentlichen, synthetischen, weitergebbar lizenzierten Datensätzen. Keine echten Mailkorpora. Die Daten liegen nur lokal unter `data/eval-datasets/` (gitignored) und werden nie committet. Laufberichte (`data/eval-runs/`) enthalten nur IDs, erwartete Werte, normalisierte Antworten, Treffer und Kosten, nie Betreff, Body oder Absender.

Code: `lib/eval-sources.ts` (Allowlist, Mapper, Stichprobe), `scripts/fetch-eval-datasets.ts`, `scripts/eval-jev.ts`, `scripts/compare-eval-runs.ts`.

## Quellen

| Kurzname | Dataset | Lizenz | Attribution | Sprachen | Zeilen (datasets-server) |
|---|---|---|---|---|---|
| `triage` | `weijianzhg/email-triage-action-seed` (config `default`, split `train`) | Apache-2.0 | weijianzhg, synthetische englische Mails | en | 3905 |
| `sinabis` | `sinabis-group/sinabis-1k-synthetic-emails` (config `default`, split `train`) | CC BY 4.0 (Namensnennung erforderlich) | sinabis-group, synthetische DE/EN/FR/IT-Geschäftsmails | de, en, fr, it | 1010 |

Spalten (über `first-rows` verifiziert): `triage` hat `subject`, `body`, `category`, `priority`, `action`, `source_round`; `sinabis` hat u. a. `lang`, `subject`, `from{name,email}`, `to`, `cc`, `body`, `text`, `case_kind`.

Im geladenen `triage`-Set kommen nur diese `category`-Werte vor: `customer_support` (577), `finance` (767), `meeting_request` (887), `personal` (821), `phishing` (500), `travel` (353). Die in der Dataset-Beschreibung genannten Werte `spam`, `newsletter`, `promotion`, `system_update`, `unknown` kommen in den Zeilen nicht vor; ihre Mapper-Einträge bleiben für den Fall einer späteren Revision erhalten und sind durch Unit-Tests abgedeckt.

Der Datensatz `triage` ist nach Kategorie sortiert; deshalb lädt `eval:fetch` standardmäßig **alle** Zeilen jeder Quelle (beide Sets sind klein), nicht nur den Anfang.

## Download und Daten-Hygiene (`eval:fetch`)

- **Vollständig:** Standard ist der komplette Split jeder Quelle in 100er-Seiten. Sicherheitsobergrenze 20 000 Zeilen je Quelle (`DEFAULT_HARD_CAP`); darüber bricht der Abruf mit dem Code `source_too_large` ab, bevor weitere Seiten geladen werden.
- **`--max-rows N`** nur für Tests und Debug: eine gleichmäßige Zufallsauswahl von `ceil(N/100)` Seiten mit festem Seed (`FETCH_SEED`), danach auf N Zeilen gekürzt. Die Obergrenze gilt dort nicht.
- **Dubletten zuerst:** Vor allem anderen werden exakte Dubletten je Quelle entfernt (SHA-256 über normalisierten Betreff + Body; Groß-/Kleinschreibung und Leerraum egal; der Body ist wie im Mapper auf `EXCERPT_MAX_CHARS` gekürzt). Die Zeile mit dem kleinsten Index bleibt. `loadHfCases` entdoppelt beim Laden nochmals (ältere Downloads) und addiert beide Zähler.
- **Manifest** (`manifest.json`, nur Zahlen): `revision` (Commit-SHA), `total_rows` (Quelle), `rows` (geschrieben), `skipped_truncated`, `duplicates_removed`, `max_rows` (`null` = vollständig) und `class_distribution` mit `raw` (Anzahl je Rohkategorie) und `mapped` (Anzahl je gemapptem Label: erwartete Kategorie, `phishing` oder `(none)`).

## Feste Aufteilung `calib` / `test` (kein Leakage)

Jeder Fall liegt deterministisch in `calib` (30 %) oder `test` (70 %): SHA-256 über den Inhalts-Hash (nicht über die ID, damit Dubletten nie getrennt werden und sich Zeilenindizes zwischen Revisionen verschieben dürfen), erstes 32-Bit-Wort durch 2^32 kleiner 0,3 ergibt `calib`. Die Zuordnung ist stabil über Läufe und Downloads; `CALIB_SHARE` und der Salt `email-agent-eval-split-v1` dürfen nicht geändert werden, ohne alle Ergebnisse neu zu bewerten.

- `eval:jev --source hf` nutzt standardmäßig `--split test`; `--split calib` ist wählbar.
- **Regel:** Schwellen (z. B. die noul-Schwelle) werden nur auf `calib` gewählt, berichtet wird auf `test`. Die Schwellen-Tabelle in `insights.md` markiert Kandidaten ausdrücklich nur als „Kandidat auf calib“ und warnt bei Läufen auf `test`.
- `dev:seed` importiert weiterhin alle (entdoppelten) Fälle beider Partitionen.

## Revision

`eval:fetch` liest die Commit-SHA über `https://huggingface.co/api/datasets/<id>` und schreibt sie in `manifest.json` und in jeden Laufbericht (`revisions`). Die datasets-server-`rows`-API nimmt keinen Revisionsparameter an und liefert immer den aktuellen Stand; die SHA dokumentiert also den Stand zum Abrufzeitpunkt, sie pinnt ihn nicht technisch. Weicht die Lizenz im Dataset-Metadatum von der Allowlist ab, bricht der Abruf mit `license_mismatch` ab. Beim Probe-Abruf am 2026-10-27: `triage` = `8c98baa8b10a1dddd676c860d9e1b86c89141c38`, `sinabis` = `cb5225000e9afc08dbca839f7ecd768178be4ba8`.

## Mapping Rohzeile zu erwarteten Labels

Erwartete Werte werden nur gesetzt, wo die Quelle sie eindeutig hergibt. Mehrdeutige Fälle haben keinen Schlüssel; Fälle ganz ohne Erwartung werden beim Laden verworfen (sie würden nur Aufrufe kosten). `id` = `<kurzname>-<Zeilenindex>`, Body gekürzt auf `EXCERPT_MAX_CHARS` (1200). Der Absender-Domain-Platzhalter bei `triage` ist `unknown.example.test` (die Quelle hat keinen Absender); bei `sinabis` kommt die Domain aus `from.email`.

| Quelle | Rohwert | `category` | `is_spam` | `is_phishing_or_scam` | `addresses_an_ai` | Begründung |
|---|---|---|---|---|---|---|
| triage | `spam` | spam | true | false | fehlt | Eindeutig Junk. Kein Phishing-Label, da Spam nicht zwingend Betrug ist. |
| triage | `phishing` | fehlt | true | true | fehlt | Phishing ist Betrug und unerwünscht; die Jev-Kategorie ist unklar (spam oder security_auth), daher keine Kategorie. |
| triage | `newsletter`, `promotion` | newsletter_promo | fehlt | false | fehlt | Massenversand-Marketing; Spam-Einstufung subjektiv, daher offen. |
| triage | `personal` | personal | fehlt | fehlt | fehlt | Nur die Kategorie ist eindeutig. |
| triage | `finance` | fehlt | fehlt | fehlt | fehlt | Kann transactional oder business sein; nicht geraten. |
| triage | `meeting_request`, `customer_support`, `travel`, `system_update`, `unknown` | fehlt | fehlt | fehlt | fehlt | Weder eindeutig business noch transactional; werden verworfen. |
| sinabis | alle Zeilen | business | false | false | false | Dataset-Beschreibung: legitime synthetische Geschäftsmails ohne Spam, Phishing oder KI-Adressierung. |

Die Frage `is_assessable` wird nie erwartet gesetzt (keine Quelle gibt sie her).

Die noul-Auswertung nutzt wie im festen Set die vorläufige Regel `Rohwert >= 0.5 gilt als true` (siehe `docs/jev-contract.md`, nur Eval).

## Stichprobe

`sampleCases(cases, { seed, n, strategy })` (und `sampleCasesDetailed` mit Schichtinfo): mulberry32, ohne Zurücklegen, unabhängig von der Eingabereihenfolge, gleicher Seed = gleiche Auswahl. Schicht = Quelle × erwartete Klasse; Klasse ist die erwartete Kategorie, sonst `phishing` (Betrugslabel ohne Kategorie), sonst `(none)`.

- `--strategy balanced` (Standard): gleich viele je Schicht, Rest fair (zufällig, je eine Stelle) verteilt. Ist eine Schicht kleiner als ihr Anteil, wird sie vollständig genommen und der Rest auf die übrigen umverteilt; solche Schichten stehen im Laufbericht (`short_strata`).
- `--strategy proportional`: Anteile wie in der Partition, Largest-Remainder-Rundung.

Der Laufbericht (ohne Inhalte) enthält zusätzlich `split`, `strategy`, `population` und `sample` (Anzahl je Schicht `<Quelle>|<Klasse>`), `short_strata` und `duplicates_removed`. Harte Grenze pro Lauf: 200 Aufrufe; optional `--max-cost <USD>`.

## Statistik in `insights.md`

`npm run eval:compare` schreibt zusätzlich zu den bisherigen Abschnitten (Header, Trefferquote je Frage, Quelle × Kategorie, Verwechslungen, noul-Verteilung, Stabilität, Auffälligkeiten):

- Trefferquote je Frage gepoolt über alle Läufe und je Lauf mit 95-%-Wilson-Intervall (`lib/eval-stats.ts`). Läufe mit überlappenden Fall-IDs sind nicht unabhängig, die gepoolten Intervalle sind dann zu eng.
- Je noul-Frage mit erwarteten true/false-Werten: Konfusionsmatrix (TP/FP/FN/TN) bei der provisorischen Schwelle, Precision, Recall, F1, Specificity, Balanced Accuracy und ROC-AUC (Rangverfahren, Gleichstände mit Durchschnittsrang; nur wenn beide Klassen vorkommen). Precision/F1 ohne Nenner erscheinen als `-`.
- Kategorie: Accuracy, Macro-F1 (ungewichtet über alle erwarteten oder geantworteten Klassen) sowie Precision/Recall/F1 je Klasse. Fälle ohne Antwort (Fehler) zählen hier nicht mit.
- Schwellen-Tabelle 0,50 bis 0,95 je noul-Frage (Precision, Recall, F1, Balanced Accuracy) mit Markierung von maximalem F1 und maximaler Balanced Accuracy (bei Gleichstand die niedrigste Schwelle) als „Kandidat auf calib“.
- Stichprobenbeschreibung: Split, Strategie, Population gegen Stichprobe je Schicht, zu kleine Schichten, Überlappung der Fall-IDs zwischen den Läufen (gesamt und paarweise).
- Hinweise bei kleinen Zellen (n < 30) und breiten Intervallen (Breite > 0,2).

## Dev-Datenbank `data/dev-synthetic.sqlite`

Damit die Entwicklung immer mit synthetischen Daten läuft, gibt es eine eigene SQLite-Datei (`DEV_SYNTHETIC_DATABASE_PATH` in `lib/constants.ts`), getrennt von `data/email-agent.sqlite`. Code: `lib/synthetic-dev-db.ts` (reine Funktionen auf einer geöffneten DB), `scripts/seed-dev-db.ts`, `scripts/eval-jev.ts`.

- **Befüllung:** `npm run dev:seed` importiert alle geladenen Fälle (auch solche ohne erwartete Labels) ohne Jev-Aufruf. `npm run eval:jev -- --source hf ...` schreibt nach dem Lauf zusätzlich die verarbeiteten Fälle samt normalisierten Antworten und `shadow_quarantine` (gleiche Persistenzfunktion wie die Pipeline, Audit-Actor `eval`); `--no-dev-db` schaltet das ab. Das feste Set schreibt keine Mails hinein. **Audit:** Die Zeile `eval_run` (nur Zähler, Treffer, Seed, Split, Strategie, Kosten) jedes Eval-Laufs, auch des festen Sets und mit `--no-dev-db`, geht ausschließlich in diese Dev-DB (`finalizeEvalRun`); die echte Datenbank wird von keinem Eval-Skript geöffnet, auch dann nicht, wenn `DATABASE_PATH` gesetzt ist (siehe `docs/DEVIATIONS.md`).
- **Zuordnung:** Konto `hf-<kurzname>` (Host `synthetic.invalid`, `INBOX`/`Junk`, `enabled = 0`, da nie ein Worker läuft). Mail: `message_id` = Fall-ID, Absender `noreply@<sender_domain>`, Betreff aus dem Fall, `received_at` deterministisch aus der Fall-ID über die letzten 14 Tage (bezogen auf den Importzeitpunkt, jeder Import verschiebt das Fenster). Location: `Junk` bei erwartetem Spam oder Phishing, sonst `INBOX`; UID = Zeilenindex + 1, `uid_validity` = 1.
- **Kein Inhalt:** Body und Auszug werden nie gespeichert (das Schema hat dafür keine Spalte); getestet mit einem Marker-Body über alle Tabellen. Absender und Betreff sind die einzigen Mailinhalte, wie im Schema vorgesehen. Die Betreffs stammen aus den oben genannten, öffentlich lizenzierten Datensätzen (Attribution wie in der Quellentabelle).
- **Ersetzen statt anhäufen:** Pro Mail, Fragenset und Modell gibt es eine Klassifikation. Ein erneuter Lauf ersetzt `model_reported` und alle Antworten (der letzte Lauf gewinnt); `audit_log` bleibt append-only und bekommt je Lauf neue Einträge (nur IDs und Zähler).
- **Ohne Antworten keine Klassifikationszeile.** Das Dashboard zeigt dann `-` (nicht klassifiziert), die Status-Zähler bleiben ehrlich bei 0. Eine `pending`-Zeile würde eine wartende Verarbeitung vortäuschen und von einer versehentlich gestarteten Pipeline aufgegriffen.
- **Schutz:** Vor jedem Schreiben prüft `assertSyntheticDatabase`, dass alle Konten der Datei synthetisch sind (ID `hf-*` und Host `synthetic.invalid`); sonst bricht der Import mit `NotSyntheticDatabaseError` ab, ohne zu schreiben.

## Festes Set v2 (T26)

`tests/fixtures/eval/email-eval-v2.jsonl`: 29 komplett erfundene, versionierte Fälle (DE und EN, Absender-Domains `*.example.test`, Platzhalter statt echter Namen und Zahlen), IDs `v2-<typ>-<n>`. Je Fall steht `expected` nur für eindeutige Fragen; neu ist `needs_my_reply`.

| Typ | Fälle | Zweck |
|---|---|---|
| `sec` | 4 | Login-Code, Passwort-Reset, Anmeldehinweis: legitim, kein Phishing, `security_auth` |
| `scam` | 4 | gefälschter Login, Paket-Phishing (DE/EN): Phishing |
| `inv` | 4 | zwei echte Rechnungen (kein Phishing, `transactional`) gegen zwei Rechnungsbetrugs-Fälle (geänderte Bankverbindung, Gutscheinkarten) |
| `news` | 3 | Newsletter mit „Antworten Sie jetzt“ / „Reply now“: `needs_my_reply = false` |
| `pers` | 3 | zwei persönliche Bitten mit Frist (`true`), ein Dank ohne Bitte (`false`) |
| `biz` | 3 | zwei Geschäftsanfragen mit Frist (`true`), eine reine Information (`false`) |
| `spam` | 3 | deutscher Werbe-Spam (`is_spam = true`, auch mit „Jetzt antworten“) |
| `inj` | 3 | Prompt-Injection-Text an eine KI (`addresses_an_ai = true`) |
| `unr` | 2 | leer / unlesbar (`is_assessable = false`) |

Lauf (Live, Nico): `npm run eval:jev -- --question-set v2 --dataset v2` (29 Aufrufe, Grenze 30). Ohne Optionen bleibt alles wie zuvor: Fragenset v1, Set v1. `--question-set` gilt auch für `--source hf`; dann wird nichts in die Dev-DB importiert (sie speichert unter dem Standard-Fragenset). `needs_my_reply` erscheint im Bericht nur, wenn ein Fall es erwartet. Die Auswertung nutzt wie bisher die vorläufige Regel `Rohwert >= 0.5`; kalibriert ist v2 nicht.

## Offline-Gate (`npm run eval`, T27)

Zweck: Änderungen am Fragenset oder an den Schwellen dürfen die erwarteten Urteile der synthetischen Sets nicht verschlechtern, und das **ohne Secrets und ohne Modellaufruf**, damit CI es prüfen kann.

- **Datasets:** `evals/datasets/*.jsonl`, eine Zeile je Fall: `id`, `dataset` (`v1`/`v2`), `question_set_version`, `origin`, `expected` und die normalisierten `answers` (nur Schlüssel, Typ, Zahl oder Optionsname, optional `probabilities`). Nie Betreff, Body, Absender oder Rohantwort (H3). Der Dateiname bindet Set und Fragenset: `email-eval-<set>__qs-<fragenset>.jsonl`.
- **Prüfung:** `evals/jev-email.eval.ts` liest alle Dateien (`lib/eval-gate.ts` validiert streng: nur IDs der synthetischen Sets, keine Freitexte, Antworten passen zum Fragenset), bildet je Fall die Urteile (`category` direkt, noul-Fragen als `Rohwert >= 0.5`, nur für Fragen mit Erwartung) und lässt Veryfronts `evalDataset` mit `metrics.answer.jsonMatch().gate()` Urteil und Erwartung vergleichen. Ein Fehlschlag macht `npm run eval` und damit CI rot. Ein Test (`tests/jev-eval-dataset.test.ts`) belegt, dass ein falsches Urteil das Gate bricht und dass das Dataset nur synthetische IDs und Antworten enthält.
- **Mitgelieferte Basis:** `email-eval-v1__qs-v1.jsonl` mit 31 Fällen: 30 Fälle des Sets v1, deren Antworten aus den erwarteten Werten **abgeleitet** sind (`origin: derived`, prüft nur die Verdrahtung, nicht Jev), und `fixture-v1-ad` mit den **echten** Antworten der v1-Fixture `tests/fixtures/jev-email-v1-response.json` (`origin: live`). Aussagekräftig wird das Gate erst mit einem echten Lauf.
- **Erneuern nach einem Live-Lauf (Nico):** `npm run eval:jev -- --write-dataset` (v1) bzw. `npm run eval:jev -- --question-set v2 --dataset v2 --write-dataset` (v2) schreibt die normalisierten Antworten des Laufs nach `evals/datasets/`. Geschrieben wird nur bei fehlerfreiem, vollständigem Lauf. Danach `npm run eval`; fällt ein Fall durch, hat Jev ihn tatsächlich anders beurteilt als erwartet: entweder Fragen verbessern oder die Erwartung im Set begründet korrigieren (und die Datei neu schreiben), dann erst committen. `--write-dataset` gilt nur für die festen Sets, nie für `--source hf`. Der Inhalt der Dateien ist synthetisch, trotzdem vor dem Commit kurz ansehen.
- **Grenzen:** Das Gate prüft gespeicherte Antworten, nicht Jev selbst. Die Regel 0.5 ist die vorläufige Eval-Regel, nicht die Kalibrierung (v2 hat keine).
