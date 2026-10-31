# 0018 Hosting: gehärtetes Docker, fly.io fra mit Volume

- Status: angenommen
- Datum: 2026-10-31
- Bezug: `Dockerfile`, `fly.toml`, `docs/fly-deploy.md`, `scripts/docker-entrypoint.sh`, `lib/fly-guard.ts`, `scripts/docker-smoke.sh`, README „Öffentlich hosten“, 0003, 0011

## Kontext
Die App soll 24/7 laufen, günstig, in Deutschland, ohne Postgres.

## Entscheidung
Docker-Image gehärtet: `USER node`, `read_only`, `cap_drop: ALL`, Daten nur unter `/data`. Auf fly.io: Region `fra`, eine immer laufende Machine `shared-cpu-1x` mit 512 MB (gemessen; 256 MB reichen nicht) (`fly scale count 1`), 1-GB-Volume `email_data` an `/data`, interner Port 3000, `BIND_ADDRESS=0.0.0.0`, `APP_PASSWORD` Pflicht (`lib/fly-guard.ts`: mit `FLY_APP_NAME` startet der Server nur mit Passwort ≥ 16 Zeichen). Secrets nur per `fly secrets set` durch Nico. Konten-Datei, Allowlist und OpenRouter-Schlüssel erst hochladen, wenn der Passwortschutz nachweislich aktiv ist (`/api/emails` → 401).

## Folgen
- Volume kann root gehören: Dockerfile-Target `fly` startet als root, der Entrypoint setzt `/data` auf `node:node` 0700 und wechselt per `setpriv` dauerhaft auf `node`. Standard-Target `app` bleibt von Anfang an `USER node`.
- Kein Auto-Stop (Worker muss laufen) und keine zweite Machine (0001).
- Docker-Smoke ist Pflicht vor Deploy, weil nur er read-only-Fehler findet.
