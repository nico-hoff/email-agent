# Jev / System One: Vertrag (T3)

Quellen: **[B]** = beobachtet (echte synthetische Antwort, `tests/fixtures/jev-minimal-response.json`, 2026-10-26, Modell `typesafe/jev-1.13`, ein Aufruf mit je einer `noul`-, `choice`- (2 Optionen) und `score`-Frage (4 Anker)). **[T]** = aus installierten Typen (`@openrouter/sdk` 1.5.8, `esm/models/decisions*.d.ts`) bzw. Context7 `/openrouterteam/typescript-sdk`. Typen und Fixture widersprechen sich nicht.

## Aufruf [T]
`systemOneCreate(client, { decisionsRequest: { model, questions, state, provider?, sessionId?, trace?, user? } }, options?)` aus `@openrouter/sdk/funcs/systemOneCreate.js`, Client `OpenRouterCore` aus `@openrouter/sdk/core.js`. Ergebnis: `res.ok` true mit `res.value` (DecisionsResponse) oder `res.error`. Fehlerklasse z. B. `ForbiddenResponseError` mit `statusCode` und `body` (JSON `{error:{message,code,metadata}}`) [B bei 403].

## Antwortform (`DecisionsResponse`)
- Top-Level [B, T]: `answers` (Record Fragename -> Antwort), `model`, `usage`, optional `id`, `provider`.
- `model` [B]: aufgelöste Version, z. B. `typesafe/jev-1.13-20260917` (nicht identisch mit der angefragten ID). `provider` [B]: `"TypeSafe"`. `id` [B]: Generation-ID (`gen-dec-...`).
- `usage` [B, T]: `inputTokens` (number), `outputTokens` (number), `cost` (number, optional; im Fixture vorhanden, ca. 0.00002 bei 473/64 Tokens).
- `answers.<key>.type` ist Diskriminator: `noul | choice | score | box` plus Unknown [T]. Code muss unbekannte/fehlende Typen fail-closed behandeln.

### noul
- [B, T] `{ type: "noul", noul: number }`. Keine `probabilities`, kein `confidence` [B, T].
- [B] Wert 0.74 bei einer offensichtlichen Werbemail auf die Frage "unsolicited promotional?" (true/false-Kriterien). Der Wert liegt also in [0,1] und wird vermutlich als Wahrscheinlichkeit/Grad für `true` gelesen.
- **Offen:** Skala (0..1 ist nur aus einem Wert geschlossen, [T] gibt `number`) und Entscheidungsschwelle sind weder in Doku/Typen noch aus einer Probe belegt. Ein Wert 0.74 bei klarer Werbung zeigt, dass keine Sättigung nahe 1.0 zu erwarten ist; Schwellen daher erst nach T12/T18 festlegen, bis dahin fail-closed (`unmapped`).

### choice
- [B, T] `{ type: "choice", choice: string, confidence?: number, probabilities?: Record<string, number> }`.
- [B] `choice` ist einer der Criteria-Schlüssel; `probabilities` hat je Option einen Wert (Summe 1: 0.98 + 0.02), `confidence` 0.96.

### score
- [B, T] `{ type: "score", score: number, confidence?, probabilities?: Record<string, number>, legend?: Record<string, ...> }`.
- [B] `score` ist der 0-basierte Index in das `criteria`-Array (Werte 0..N-1; hier 0..3, Ergebnis 0). `probabilities` hat Schlüssel "0".."3" (Summe 1), `legend` bildet Index auf den Ankertext ab, `confidence` 1.
- **Offen:** ob `score` bei Unsicherheit nicht ganzzahlig werden kann (ein Fall beobachtet, ganzzahlig).

## Wahrscheinlichkeiten ja/nein
- `noul`: keine Wahrscheinlichkeiten, nur der Skalar `noul` [B].
- `choice` und `score`: ja, `probabilities` pro Option/Index, optional typisiert [B, T]. Als optional behandeln.

## SDK-Retries
- **Default [T, `funcs/systemOneCreate.js`]:** ohne Angabe Backoff (initial 500 ms, max 60 s, Exponent 1.5, `maxElapsedTime` 3 600 000 ms = 1 h), `retryConnectionErrors: true`, Retry-Codes `["5XX"]`. Ein hängender Aufruf kann also bis zu 1 h dauern.
- **Abschalten [T, Context7]:** `RetryConfig = { strategy: "none" } | { strategy: "backoff", ... }`.
  - Pro Aufruf: `systemOneCreate(client, req, { retries: { strategy: "none" } })`.
  - Am Client: `new OpenRouterCore({ apiKey, retryConfig: { strategy: "none" } })`.
  - Zusätzlich möglich: `timeoutMs` (Client-Option und `RequestOptions`).
- Die Probe lief mit beidem und genau einem Request [B].

## Fehler [B/T]
- [B] 403 `ForbiddenResponseError`, u. a. bei überschrittenem Key-Limit; Body `{error:{message,code,metadata}}`.
- [T/Plan] dokumentiert: 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529.

## Vollset-Probe (T12) [B]
Quelle: `tests/fixtures/jev-email-v1-response.json` (2026-10-26, `typesafe/jev-1.13`, ein Aufruf, alle 9 Fragen von `email-classification-v1`, offensichtlich synthetische Werbemail mit einem Satz an einen KI-Assistenten, SDK-Retries aus). Antwortform entspricht den Typen [T]; keine Abweichung zu T3. Usage: 1189 Input-, 238 Output-Tokens, Kosten ca. 0.00005.

- **Alle 9 Antworten** kommen unter ihren Fragenamen zurück; Diskriminator `type` je Antwort wie gefragt (`noul`, `choice`, `score`).
- **choice:** `probabilities` enthält **jede** Option des Fragensets (auch mit Wert 0), Summe 1 (category: spam 0.76, newsletter_promo 0.12, unclear 0.12, Rest 0; Summe 1). `choice` ist die Option mit dem höchsten Wert. `confidence` (0.72 bei category, 0.55 bei route) ist **nicht** gleich der Wahrscheinlichkeit der gewählten Option (0.76 bzw. 0.66); Zusammenhang nicht belegt, daher nicht verwenden.
- **score:** `score` ist **nicht ganzzahlig**: urgency 0.05, importance 0.09. Beides entspricht dem Erwartungswert über den Index mit `probabilities` (urgency: 0.01*2 + 0.01*3 = 0.05; importance ca. 0.04*1 + 0.02*3 = 0.10, beobachtet 0.09, vermutlich gerundete Wahrscheinlichkeiten). Bereich damit 0..3 (0..N-1) als Kontinuum. Das korrigiert die T3-Annahme "ganzzahliger Index" (dort nur ein Fall mit sicherer Wahrscheinlichkeit 1). `probabilities` hat Schlüssel "0".."3" (Summe 1), `legend` bildet Index auf die vier Ankertexte ab, `confidence` 0.9/0.95.
- **noul:** weiterhin nur `noul: number`, keine `probabilities`/`confidence`. Beobachtet (Werte in [0,1]): is_spam 0.82, is_phishing_or_scam 0.30, addresses_an_ai 0.96, needs_my_reply 0.83, is_assessable 0.95. Lesart als Grad für `true` passt zu is_spam, addresses_an_ai, is_assessable und is_phishing_or_scam. **Auffällig:** `needs_my_reply` = 0.83 bei einer Werbemail ohne Rückfrage; entweder wird "Handlung erwartet" (Kaufaufforderung) weit gelesen oder die Skala ist nicht als Wahrscheinlichkeit für `true` zu verstehen. Skala und Schwelle bleiben **offen** (ein Datenpunkt je Frage); `interpretNoul` bleibt fail-closed (`unmapped`), Schwellen erst nach T18 (`eval:jev`) festlegen. Die Werte sind keine harte Sättigung (0.82 bei klarem Spam).
- **Typen vs. Beobachtung:** nichts widerspricht sich; die Typen lassen `score`-Zahlen offen, die Beobachtung zeigt Nachkommawerte.

## Kalibrierung

Version 1, 2026-10-27, Fragenset `email-classification-v1`. Konfiguration: `config/noul-calibration.ts` (versioniert im Repo, von `interpretNoul` einmal geladen und mit zod validiert; ungültige Datei oder falsches Fragenset ist ein Startfehler, nie ein stilles Fallback). Ort: ein TypeScript-Datenmodul statt JSON, weil Veryfront Tools und API-Routen in einem Temp-Verzeichnis bündelt (kein brauchbares `import.meta.url`, kein JSON-Loader) und der Import so in Node, im Build und im Client gleich funktioniert; nicht in `data/`. Ein Test hält Datei und diese Tabelle synchron. **Vorläufig**: Werte werden mit Nicos `insights-calib.md` (Kalibrierteil) bestätigt oder angepasst; jede Änderung ist eine neue Version.

Regel: `positive` wenn Rohwert >= Schwelle, sonst `negative`. Nicht aufgeführte Fragen bleiben `unmapped`, ebenso jede Antwort, deren `question_set_version` nicht zur Konfiguration passt oder fehlt (fail-closed).

Datenbasis: HF-Evals 2026-10-27 (3 x 100, triage+sinabis, gemischter Split); echtes Sample web2 2026-10-26 (153 Spam, 6 INBOX), nur Aggregate.

| Frage | Schwelle | Begründung |
| --- | --- | --- |
| `is_spam` | 0.80 | Precision vor Recall. Im echten Sample lag INBOX max bei 0.65 und Spam p10 bei 0.87; in den HF-Evals lagen Nicht-Spam-Fälle bei max 0.17. Bei 0.80 gibt es auf beiden Datensätzen keine False Positives. |
| `is_phishing_or_scam` | 0.50 | In den HF-Evals sind beide Klassen klar getrennt (false max 0.30, true min 0.85). Login- und Sicherheitsmails im echten Sample erreichten bis 0.95; das fängt D15 ab (`security_auth` ist nie Shadow-Kandidat), Phishing ist kein Shadow-Eingang. |
| `addresses_an_ai` | 0.30 | Bewusst niedrig, fail-closed für die Agent-Sperre D18. Negative Fälle lagen bei max 0.14 (HF) bzw. 0.04 (echt). Positive Beispiele fehlen noch. |

Nicht kalibriert (bleiben `unmapped`): `needs_my_reply` und `is_assessable`. Es gibt keine Labels; Fragenset v2 (T26) folgt.

Folgen:
- Shadow-Kandidaten bleiben weiterhin aus (gewollt): sie brauchen `needs_my_reply` und `is_assessable`. D15: `security_auth` ist als Kategorie nie Kandidat (Grund `security_auth`), unabhängig von allen Werten.
- „Braucht Antwort“ bleibt aus (O4).
- Agent-Sperre (D18) unverändert streng, aber nicht mehr pauschal: Eine Mail geht durch, wenn das Fragenset passt, `addresses_an_ai` unter 0.30 liegt, die Kategorie nicht `security_auth` ist und `is_assessable` nicht negativ ist (heute immer `unmapped`, sperrt nicht). Ab 0.30, `unmapped` (auch bei fehlender oder anderer Version) oder `security_auth` sperrt.
- `GET /api/emails` liefert je noul-Antwort `reading` (`positive|negative|unmapped`), `threshold` und `calibration_version` (bei `unmapped` beide `null`); die UI zeigt Ja/Nein mit Schwelle und Version, unkalibrierte Fragen weiter als Rohwert „unkalibriert“.
