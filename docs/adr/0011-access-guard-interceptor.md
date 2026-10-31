# 0011 Zugangsmodi, Guard als `requestInterceptor`, keine `middleware.ts`

- Status: angenommen
- Datum: 2026-10-31
- Bezug: `docs/access-contract.md`, `lib/auth.ts` (`selectAuthMode`), `lib/auth-runtime.ts`, `lib/password.ts`, `tests/no-root-middleware.test.ts`, `docs/DEVIATIONS.md`

## Kontext
Zugang zuerst nur übers Tailnet (`tailscale serve`, Header `Tailscale-User-Login`). Für fly.io braucht es öffentliches Hosting mit Passwort. Eine Root-`middleware.ts` bricht im read-only-Container (Veryfront schreibt `.vf-middleware-*.mjs` neben die Quelle → 500 überall); `createHandler` lässt API-Routen im Sandbox-Worker laufen (`WorkerEgressBlockedError`).

## Entscheidung
Drei Modi, Reihenfolge in `selectAuthMode`: **synthetic** (Dev-DB, feste Identität) → **password** (`APP_PASSWORD` gesetzt; Tailscale-Header wird ignoriert; < 16 Zeichen ⇒ fail-closed) → **tailnet** (Header + `auth-allowlist.json`). Der Guard läuft als `requestInterceptor` von `startServer`, fail-closed, und schreibt verweigerte Anfragen auf `GET /api/auth/deny?k=page|api|forbidden` um. Passwort: scrypt + `timingSafeEqual`, global 10 Versuche / 15 min, 500 ms Verzögerung pro Fehlschlag; Sitzungs-Cookie im Passwort-Modus immer `Secure` (außer Loopback-`BIND_ADDRESS`).

## Folgen
- Keine `middleware.ts` im Wurzelverzeichnis (Test erzwingt das).
- Veryfront entfernt `x-forwarded-*`; HTTPS-Erkennung hinter fly geht nicht, daher unbedingtes `Secure`.
- Ohne Volume ist `auth-secret` flüchtig (Neustart = Logout).
