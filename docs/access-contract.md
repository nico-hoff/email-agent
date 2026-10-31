# Zugangsvertrag (D16, O2a, T31/T32)

Stand: 2026-10-27. Quellen: Tailscale-Doku über Context7 (`/websites/tailscale`) und https://tailscale.com/kb/1312/serve (Seite "Tailscale Serve", Abschnitt Identity headers), CLI-Referenz https://tailscale.com/docs/reference/tailscale-cli/serve. Eine Probe im echten Tailnet (T31) steht noch aus (Nico).

## Drei Modi (seit 2026-10-31)

Die Wahl ist rein (`selectAuthMode` in `lib/auth.ts`) und fällt je Prozess:

| Modus | Wann | Identität | Header `Tailscale-User-Login` |
| --- | --- | --- | --- |
| `synthetic` | `server.ts --synthetic` (`npm run dev`) | fest `dev@synthetic.invalid`, nur Loopback-Hosts | wie unten |
| `password` | Env `APP_PASSWORD` gesetzt (auch leer oder kurz) | fest `password-user` | **wird nie gelesen**, auch nicht bei Anwesenheit |
| `tailnet` | sonst | Login aus dem Header, gegen die Allowlist | Beweis laut Abschnitt unten |

Der Tailnet-Header ist nur hinter Tailscale Serve glaubwürdig. Auf einem öffentlichen Host (fly.io) kann ihn jeder senden; der Passwort-Modus ignoriert ihn deshalb vollständig, und die Allowlist-Datei ist dort nicht nötig. Ein Session-Cookie gilt nur im Modus, in dem es ausgestellt wurde: im Passwort-Modus zählt allein die Identität `password-user` (ein Cookie mit einem Tailnet-Login ist wertlos, auch mit gültiger Signatur), im Tailnet-Modus muss der Login auf der Allowlist stehen.

### Passwort-Modus

- `APP_PASSWORD` (Laufzeit-Variable, z. B. `fly secrets set`; Ausnahme von STOP-6 auf Nicos Wunsch, `docs/DEVIATIONS.md`) hat mindestens 16 Zeichen. Kürzer oder leer: fail-closed (Login `503 server_misconfigured`, Session-Antwort `{mode:"password", configured:false}`, Start-Log einmal `warning: APP_PASSWORD too short, password login disabled`, nie mit Wert).
- `GET /api/auth/session` meldet `{mode, configured, csrfToken, signedIn}` ohne Identität. Das CSRF-Token ist an `password-user` gebunden.
- `POST /api/auth/login` mit JSON `{"password": "..."}`: Reihenfolge `503` (nicht konfiguriert), `403` (Veryfront-Double-Submit plus `x-app-csrf` plus Origin; kostet keinen Versuch), `429` (globaler Limiter: 10 Fehlversuche je 15 Minuten, `retry-after`), Vergleich, dann `200` mit Cookie oder 500 ms Pause und `401 {"error":"invalid_credentials"}` (eine einheitliche Antwort für falsch, leer, kaputt; kein Hinweis auf „fast richtig“). Der Platz im Limiter wird vor der Prüfung belegt (parallele Versuche können das Budget nicht überschreiten); ein erfolgreicher Login gibt nur seinen eigenen Platz zurück und setzt die Fehlversuche nicht zurück.
- Vergleich: beide Seiten mit `scrypt` und prozessweitem zufälligem Salz ableiten, `timingSafeEqual` (`lib/password.ts`). Klartext wird nur beim Start abgeleitet und nicht behalten; Kandidaten über 1024 Zeichen sind sofort falsch.
- Cookie `ea_session`: `HttpOnly`, `SameSite=Strict`, **immer `Secure`**. Einzige Ausnahme für lokale Tests: Listener auf Loopback (`BIND_ADDRESS` ungesetzt oder `127.x`/`localhost`/`::1`), `Host` ist Loopback, keine Proxy-Header (`isLoopbackDirect`). `BIND_ADDRESS=0.0.0.0` (fly.io, Docker) schaltet die Ausnahme ab. `X-Forwarded-Proto` taugt nicht als Signal: Der Veryfront-Server entfernt `x-forwarded-*`, bevor Routen laufen (im Produktionsmodus beobachtet; `isHttpsRequest` bleibt nur für den synthetischen Modus).
- Sitzungsgeheimnis `auth-secret` neben der Datenbank wie bisher. Ohne Volume entsteht es bei jedem Start neu: alle Sitzungen werden dann ungültig (bewusst nicht geändert).
- Mehrere Maschinen: Limiter und Salz leben je Prozess; das Geheimnis liegt je Maschine im eigenen Dateisystem, Sitzungen gelten also nur auf der Maschine, die sie ausgestellt hat. Eine Maschine genügt.

## Was Tailscale Serve zusichert (laut Doku)

- Serve setzt beim Proxy an das lokale Backend `Tailscale-User-Login` (Login-Name), `Tailscale-User-Name` (Anzeigename) und `Tailscale-User-Profile-Pic` (nur wenn der Identity Provider ein Bild liefert).
- Findet Serve diese Header bereits in der eingehenden Anfrage, **entfernt es sie** ("to avoid header spoofing"). Über das Tailnet kann der Header also nicht gefälscht werden.
- Nicht gesetzt werden die Header für Verkehr von **Tagged Devices** und für **Funnel** (öffentlich). Beides führt bei uns zu "keine Identität" und damit zu 401. Funnel wird nie aktiviert.
- Gesetzt werden sie auch für Nutzer, denen ein Gerät geteilt wurde (Shared Nodes). Deren Login steht nicht auf der Allowlist (O3) und wird mit 403 abgelehnt.
- `--bg` ist laut CLI-Referenz ein Flag von `tailscale serve` (Hintergrundbetrieb); die Seite zu Serve nennt es nicht, die Referenz schon.

## Folgerung für die App

- Die App bindet an `127.0.0.1` (D12), nie an `0.0.0.0`; Compose veröffentlicht nur `127.0.0.1:3000`. Von außerhalb des Hosts erreicht niemand die App ohne Serve, und Serve überschreibt den Header.
- Verbleibendes Restrisiko: Ein Prozess **auf demselben Host** kann direkt `127.0.0.1:3000` ansprechen und den Header selbst setzen (nichts entfernt ihn dort). Die Vertrauensgrenze ist damit der Host (Einzelnutzer-Gerät, Container mit Port-Mapping nur auf Loopback). Das wurde gegen STOP-9 abgewogen: Header von außen nicht fälschbar, lokaler Prozess bereits mit Zugriff auf die Datenbank. Wer das nicht akzeptiert, muss einen Proxy-Nachweis ergänzen (z. B. von Serve gesetzte Header per Probe in T31 ermitteln) und STOP-9 an Nico melden.
- Der Browser-Origin hinter Serve ist `https://<gerät>.<tailnet>.ts.net`. Die App leitet erlaubte Origins aus dem `Host`-Header ab (muss in der T31-Probe bestätigt werden, dass Serve `Host` durchreicht; sonst schlägt der Login mit `origin_mismatch` fehl, ohne Sicherheitsverlust).

## Ablauf

1. Aufruf einer Seite ohne Session-Cookie leitet auf `/welcome` um (APIs: 401).
2. `/welcome` ruft `GET /api/auth/session`: 401 ohne Identität, 403 bei fremdem Login, sonst Login-Name und ein CSRF-Token (an die Identität gebunden, 12 h).
3. Knopf "Login" sendet `POST /api/auth/login` (Veryfront-CSRF-Header `x-csrf-token` plus App-Token im Header `x-app-csrf`, Origin muss zum Host passen, höchstens 10 Versuche je Identität in 10 Minuten). Antwort: Cookie `ea_session` (HMAC, `HttpOnly`, `SameSite=Strict`, `Secure` außer im synthetischen Dev-Modus über HTTP, 30 Tage).
4. Jede Anfrage prüft das Cookie gegen die Allowlist (Entfernen eines Logins beendet seine Sitzungen sofort). `POST /api/auth/logout` löscht das Cookie.
5. Offen (ohne Session): `/api/health`, `/welcome`, `/api/auth/*` (prüfen selbst), PWA-Dateien aus `public/`, `/_vf_modules/`, `/_vf_styles/`, `/_veryfront/` (nur Code und Styles, keine Mail-Daten).

## Dateien und Geheimnisse

Alles liegt neben der Datenbank (`data/` lokal, Volume `/data` in Docker), nie in Git, Verzeichnis 0700.

- `auth-allowlist.json`: `{"logins": ["nico@example.com"]}` (Groß-/Kleinschreibung egal). Fehlt die Datei oder ist sie ungültig, ist niemand zugelassen. Wird bei jeder Anfrage gelesen, kein Neustart nötig.
- `auth-secret`: 32 zufällige Bytes, beim ersten Start erzeugt (Modus 0600, atomar). Daraus werden getrennte Schlüssel für Session und CSRF abgeleitet. Zu offene Rechte führen zum Fehler (fail-closed). Löschen macht alle Sitzungen ungültig.
- `dev-synthetic-auth-secret`: eigenes Geheimnis des synthetischen Dev-Modus.
- Keine neue Env-Variable. Der synthetische Modus wird daran erkannt, dass `server.ts --synthetic` `DATABASE_PATH` auf `data/dev-synthetic.sqlite` setzt.

## Synthetischer Dev-Modus

Nur dort (`npm run dev`) gilt ohne Header die feste Identität `dev@synthetic.invalid`; erlaubte Hosts sind dann nur `localhost`/`127.0.0.1`/`[::1]` (Schutz gegen DNS-Rebinding). `dev:live` und `start` kennen die Dev-Identität nicht.

## Veryfront-CSRF (warum POST zunächst 403 war)

Veryfront prüft in Dev und Produktion jede Anfrage außer GET/HEAD/OPTIONS per Double-Submit: Cookie `__Host-vf_csrf` (wird bei HTML-Dokumenten gesetzt) muss im Header `x-csrf-token` zurückkommen (Doku: https://veryfront.com/docs/code/guides/security-headers). Der Schutz bleibt an; Browser-Code nutzt `csrfMutationHeaders` aus `veryfront/index.client`. Unser eigenes Token (`lib/csrf.ts`) wandert deshalb im Header `x-app-csrf`. `security.csrf.excludePaths` wird nicht verwendet.

## Wo der Guard läuft (seit 2026-10-30)

Nicht mehr in einer Root-`middleware.ts`, sondern als `requestInterceptor` von `startServer` (`server.ts`, `interceptRequest` in `lib/auth-runtime.ts`). Grund: Veryfront schreibt eine Root-Middleware transpiliert als `.vf-middleware-<uuid>.mjs` neben die Quelle, was im gehärteten Container (`USER node`, `read_only`) mit `EACCES`/`EROFS` scheitert (siehe `docs/DEVIATIONS.md`).

- Regeln unverändert (`guardRequest`): offen sind `/api/health`, `/welcome`, `/api/auth/{session,login,logout}`, die Deny-Route, Dateien aus `public/` und `/_vf_modules/`, `/_vf_styles/`, `/_veryfront/`. Seiten ohne Session → 303 `/welcome`, APIs → 401.
- Der Interceptor kann nur eine Request zurückgeben. Eine verweigerte Anfrage wird in einen frischen `GET /api/auth/deny?k=page|api|forbidden` ohne Header und Body umgeschrieben; die öffentliche Route antwortet allein aus diesem Parameter (303/401/403, alles Unbekannte 401, `Cache-Control: no-store`) und ist bei direktem Aufruf harmlos. Jeder Fehler im Guard (auch eine nicht parsebare URL) ergibt dieselbe Umschreibung: fail-closed.
- Der Interceptor läuft vor allen Veryfront-Routen: `/api/agents`, `/api/agents/:id` (waren schon vorher geschützt), `/healthz`, `/readyz`, `/_health`, `/_ws` (vorher ohne Session erreichbar) und unbekannte Pfade verlangen jetzt eine Session. Der Healthcheck der Container nutzt `/api/health`. Dort wäre ohnehin kein Mailinhalt gewesen.
- WebSocket-Upgrades (nur Dev-HMR auf `/_ws`) laufen nicht durch den Interceptor; Veryfront entscheidet selbst, sie tragen nur Reload-Meldungen. Im Produktionsmodus gibt es keinen HMR.
