# 0012 Doppeltes CSRF-Token, Rate-Limits im Speicher

- Status: angenommen
- Datum: 2026-10-28
- Bezug: `lib/rate-limit.ts`, `lib/csrf.ts`, Client `csrfMutationHeaders` aus `veryfront/index.client`

## Kontext
Mutierende Routen (Erledigt, Feedback, Regeln, Undo, Login) brauchen CSRF-Schutz und Missbrauchsbremsen. Veryfront hat eingebautes Double-Submit-CSRF (`__Host-vf_csrf` + `x-csrf-token`), das POSTs ohne Token mit 403 ablehnt.

## Entscheidung
Beide Schichten: Veryfronts CSRF **und** eigener Header `x-app-csrf`. Rate-Limits als Sliding Window im Speicher pro Identität (`createRateLimiter`, `maxKeys` begrenzt, voll ⇒ fail-closed); hält nur Schlüssel und Zeitstempel.

## Folgen
- Client muss beide Header senden; Tests müssen `Accept: text/html` setzen, damit Veryfront im Prod-Modus das CSRF-Cookie ausgibt.
- Limits gelten pro Prozess und gehen beim Neustart verloren — passt zu 0001 (eine Instanz).
