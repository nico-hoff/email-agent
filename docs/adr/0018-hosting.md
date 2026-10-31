# 0018 Hosting: gehärtetes Docker, fly.io fra mit Volume

- Status: angenommen (fly.toml in Arbeit)
- Datum: 2026-10-31
- Bezug: `Dockerfile`, `scripts/docker-smoke.sh`, README „Öffentlich hosten“, 0003, 0011

## Kontext
Die App soll 24/7 laufen, günstig, in Deutschland, ohne Postgres.

## Entscheidung
Docker-Image gehärtet: `USER node`, `read_only`, `cap_drop: ALL`, Daten nur unter `/data`. Auf fly.io: Region `fra`, eine immer laufende kleinste Machine (`fly scale count 1`), 1-GB-Volume `email_data` an `/data`, interner Port 3000, `BIND_ADDRESS=0.0.0.0`, `APP_PASSWORD` Pflicht (Start verweigert ohne). Secrets nur per `fly secrets set` durch Nico. Konten-Datei, Allowlist und OpenRouter-Schlüssel erst hochladen, wenn der Passwortschutz nachweislich aktiv ist (`/api/emails` → 401).

## Folgen
- Volume gehört root: `/data` muss einmal an `node` übergeben werden (Lösung im fly.toml-Branch).
- Kein Auto-Stop (Worker muss laufen) und keine zweite Machine (0001).
- Docker-Smoke ist Pflicht vor Deploy, weil nur er read-only-Fehler findet.
