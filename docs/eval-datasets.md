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

Der Datensatz `triage` ist nach Kategorie sortiert. `eval:fetch` verteilt deshalb bei `--max-rows` unterhalb der Gesamtzahl die 100er-Seiten gleichmäßig über das ganze Set, statt nur den Anfang zu laden.

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

`sampleCases(cases, { seed, n })`: mulberry32, geschichtet nach Quelle × erwarteter Kategorie (fehlende Kategorie = eigene Schicht), reihum gleich viele je Schicht, unabhängig von der Eingabereihenfolge. Gleicher Seed, gleiche Auswahl; andere Seeds, andere Auswahl. Harte Grenze pro Lauf: 200 Aufrufe; optional `--max-cost <USD>`.

## Dev-Datenbank `data/dev-synthetic.sqlite`

Damit die Entwicklung immer mit synthetischen Daten läuft, gibt es eine eigene SQLite-Datei (`DEV_SYNTHETIC_DATABASE_PATH` in `lib/constants.ts`), getrennt von `data/email-agent.sqlite`. Code: `lib/synthetic-dev-db.ts` (reine Funktionen auf einer geöffneten DB), `scripts/seed-dev-db.ts`, `scripts/eval-jev.ts`.

- **Befüllung:** `npm run dev:seed` importiert alle geladenen Fälle (auch solche ohne erwartete Labels) ohne Jev-Aufruf. `npm run eval:jev -- --source hf ...` schreibt nach dem Lauf zusätzlich die verarbeiteten Fälle samt normalisierten Antworten und `shadow_quarantine` (gleiche Persistenzfunktion wie die Pipeline, Audit-Actor `eval`); `--no-dev-db` schaltet das ab. Das feste Set schreibt nichts hinein.
- **Zuordnung:** Konto `hf-<kurzname>` (Host `synthetic.invalid`, `INBOX`/`Junk`, `enabled = 0`, da nie ein Worker läuft). Mail: `message_id` = Fall-ID, Absender `noreply@<sender_domain>`, Betreff aus dem Fall, `received_at` deterministisch aus der Fall-ID über die letzten 14 Tage (bezogen auf den Importzeitpunkt, jeder Import verschiebt das Fenster). Location: `Junk` bei erwartetem Spam oder Phishing, sonst `INBOX`; UID = Zeilenindex + 1, `uid_validity` = 1.
- **Kein Inhalt:** Body und Auszug werden nie gespeichert (das Schema hat dafür keine Spalte); getestet mit einem Marker-Body über alle Tabellen. Absender und Betreff sind die einzigen Mailinhalte, wie im Schema vorgesehen. Die Betreffs stammen aus den oben genannten, öffentlich lizenzierten Datensätzen (Attribution wie in der Quellentabelle).
- **Ersetzen statt anhäufen:** Pro Mail, Fragenset und Modell gibt es eine Klassifikation. Ein erneuter Lauf ersetzt `model_reported` und alle Antworten (der letzte Lauf gewinnt); `audit_log` bleibt append-only und bekommt je Lauf neue Einträge (nur IDs und Zähler).
- **Ohne Antworten keine Klassifikationszeile.** Das Dashboard zeigt dann `-` (nicht klassifiziert), die Status-Zähler bleiben ehrlich bei 0. Eine `pending`-Zeile würde eine wartende Verarbeitung vortäuschen und von einer versehentlich gestarteten Pipeline aufgegriffen.
- **Schutz:** Vor jedem Schreiben prüft `assertSyntheticDatabase`, dass alle Konten der Datei synthetisch sind (ID `hf-*` und Host `synthetic.invalid`); sonst bricht der Import mit `NotSyntheticDatabaseError` ab, ohne zu schreiben.
