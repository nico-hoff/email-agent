# 0051 Veryfront nur noch für Agenten, Tools und Skills im Backend

- Status: Entwurf (zu evaluieren)
- Datum: 2026-11-07
- Bezug: Wunsch Nico 2026-11-07, 0029 (Veryfront), 0045, 0048 (Monorepo: `apps/api`, `apps/worker`, `apps/web`)

## Kontext
Veryfront liefert heute alles: Seiten, API-Routen, Login-Middleware und die Agenten-Primitive (`agent()`, `tool()`, Skills, Evals). Mit dem Monorepo (0048) bekommen Web und API eigene Apps. Die Agenten-Primitive sind praktisch und Open Source. Nico möchte sie weiter nutzen, aber im Backend statt in einer Fullstack-App.

Stand der Agenten: `replyDrafter` und `briefing` (Veryfront-Agenten), Tools unter `tools/`, Offline-Evals über `npm run eval`. Die Jev-Klassifikation, der Kern des Produkts, läuft nicht über Veryfront, sondern direkt über `@openrouter/sdk`.

## Zu prüfen (Context7 `/websites/veryfront`, dann Probe)
1. Lassen sich `agent()`, `tool()` und Skills ohne Veryfront-Server als Bibliothek aufrufen, etwa aus einem Worker oder einem API-Handler eines anderen Frameworks?
2. Laufen die Evals (`veryfront eval`) ohne die App-Struktur `app/`?
3. Was hängt an Veryfront-Diensten (Cloud-Gateway, Login) und was ist rein lokal?
4. Erlaubt die Lizenz die Nutzung als Bibliothek in einem kommerziellen Produkt?

## Optionen
- **A:** Veryfront bleibt als schlanker Agenten-Dienst (eigene App `apps/agents` oder Teil von `apps/worker`), API und Web sind eigene Apps.
- **B:** Agenten-Primitive als Bibliothek direkt in `apps/worker`/`apps/api`, ohne Veryfront-Server.
- **C:** Ersatz durch eine andere Agenten-Bibliothek (OpenRouter-SDK direkt, AI SDK o. ä.). Nico 2026-11-07: keine Bindung an Veryfront. Bei zu vielen Eigenheiten ist C ausdrücklich in Ordnung.

## Bisher erlebte Eigenheiten (Entscheidungshilfe)
Root-`middleware.ts` bricht den read-only-Container, CSS-Scanner und Worktrees, CSRF-Cookie hinter Proxys nur mit `VERYFRONT_TRUST_FORWARDED_HEADERS`, `localhost` zeigt im Production-Modus die Projektübersicht, veralteter Modul-Cache, Paketnamen werden auf das CDN umgeschrieben (`docs/veryfront-guide.md`).

## Einordnung
Generative Funktionen sind Zusatz (`VISION.md`). Die Entscheidung blockiert weder den Monorepo-Umbau noch Postgres. Sie fällt spätestens mit Schritt 3 aus 0048 (Veryfront-App ablösen).
