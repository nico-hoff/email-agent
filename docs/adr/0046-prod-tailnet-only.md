# 0046 Prod nur im Tailnet: Tailscale in der fly-Maschine, keine öffentliche IP

- Status: angenommen
- Datum: 2026-11-04
- Bezug: Wunsch Nico 2026-11-04 (Variante B), ändert 0018/0021 (öffentlicher fly-Endpunkt), ergänzt 0022 (Nutzerkonten bleiben), 0027 (Web-Push braucht HTTPS), `fly.toml`, `scripts/docker-entrypoint.sh`

## Kontext
Die App soll auf fly.io laufen, aber nicht offen im Internet stehen. Geprüfte Alternativen (fly.io-Doku über Context7, 2026-11-04):
- **Flycast privat** (`fly ips allocate-v6 --private`, Zugang über `fly proxy` oder WireGuard-Peer): Flycast ist nur HTTP. Safari speichert dann kein `Secure`-Cookie, die PWA lässt sich nicht installieren, Web-Push geht nicht. Für den iPhone-Alltag ungeeignet.
- **Öffentlich mit Nutzerkonten** (bisher): funktioniert, aber die Login-Seite steht im Internet.
- **Tailscale in der Maschine**: HTTPS mit gültigem Zertifikat über `tailscale serve` (`<host>.<tailnet>.ts.net`), Zugang nur für Geräte im Tailnet; PWA und Push funktionieren.

## Entscheidung
- `fly.toml` hat **kein** `[http_service]` und keine `[[services]]`: Der fly-Proxy routet keinen Verkehr zur App. Öffentliche IPs werden einmalig freigegeben (`fly ips list`, `fly ips release <ip>`); eine neue App wird mit `fly deploy --no-public-ips` angelegt.
- Das Image (Target `fly`) enthält `tailscaled` und `tailscale` aus dem offiziellen Image, gepinnt auf Version und Digest. Der Entrypoint startet Tailscale nur bei `TAILSCALE_ENABLE=1`: im **Userspace-Modus als Nutzer `node`** (kein TUN, keine Root-Rechte), Zustand unter `/data/tailscale` auf dem Volume (stabile Identität über Neustarts), danach `tailscale serve --bg --https=443 http://127.0.0.1:3000`.
- Der Auth-Key `TS_AUTHKEY` ist ein Secret (Katalog in `scripts/fly-secrets.ts`, Workflow „Secrets nach fly“). Er wird nur bis zur ersten Anmeldung gebraucht, per Datei (nicht per Argument) an `tailscale up` gegeben, danach gelöscht und vor dem App-Start aus der Umgebung entfernt. Nie in Logs.
- Die App bleibt im Nutzer-Modus (`AUTH_MODE=users`): Tailscale ist die Netzgrenze, die Nutzerkonten bleiben die Anwendungsgrenze. Der Tailscale-Header wird im Nutzer-Modus nicht gelesen.
- `BIND_ADDRESS=0.0.0.0` bleibt, weil fly’s Health-Check (`[checks]`, Port 3000, `/api/health`) die App über das private fly-Netz erreichen muss. Ohne Service und öffentliche IP ist das nur aus dem privaten Netz der eigenen fly-Organisation möglich.
- `VERYFRONT_TRUST_FORWARDED_HEADERS=1` bleibt: `tailscale serve` beendet TLS und setzt `X-Forwarded-Proto` (wie im Staging auf dem Mac erprobt).

## Folgen
- Zugang für Nico: iPhone und Mac im Tailnet, `https://email-agent.<tailnet>.ts.net`. Ohne Tailscale-App ist die App nicht erreichbar, auch nicht für eingeladene Nutzer außerhalb des Tailnets (Einladung ins Tailnet nötig oder später Tailscale Funnel/öffentlicher Endpunkt mit eigener ADR).
- Im Tailnet müssen MagicDNS und HTTPS-Zertifikate aktiviert sein (bei Nico schon für Staging genutzt).
- Für go2market (offene Registrierung) passt das nicht; dann zurück zu einem öffentlichen Endpunkt mit eigener ADR.
- Ein Ausfall von `tailscaled` macht die App unerreichbar, ohne dass fly die Maschine neu startet (der Health-Check prüft nur die App). Grenze dokumentiert; Beobachtung nach dem ersten Betrieb.
- Die echte Anmeldung im Tailnet ist nur mit Nicos Auth-Key prüfbar; lokal belegt sind: Image baut, App startet ohne Tailscale, mit Tailscale startet `tailscaled` als `node` und bricht ohne Key sauber ab.
