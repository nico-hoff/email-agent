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
