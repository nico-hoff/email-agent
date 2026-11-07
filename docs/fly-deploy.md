# Deployment auf fly.io

> **Seit 2026-11-04 nur im Tailnet erreichbar (ADR 0046).** Kein `[http_service]`, keine öffentliche IP: Tailscale läuft in der Maschine und liefert HTTPS auf `https://email-agent.<tailnet>.ts.net`. Login weiter mit Nutzerkonten (`AUTH_MODE=users`). Der Start-Schutz `packages/core/src/fly-guard.ts` lässt auf fly nur den Nutzer- oder Passwort-Modus zu. Der frühere öffentliche Betrieb mit `APP_PASSWORD` ist abgelöst.

Nichts in diesem Repo ruft fly auf. Alle `fly ...`-Befehle unten führt Nico selbst aus.

## Was `fly.toml` festlegt

| Einstellung | Wert | Grund / Beleg |
|---|---|---|
| `primary_region` | `fra` | Frankfurt, Deutschland: https://docs.fly.io/reference/regions |
| `[build] build-target` | `fly` | Docker-Stage ohne `USER` (siehe Volume-Rechte); Syntax https://docs.fly.io/reference/configuration (Abschnitt `build`) |
| kein `[http_service]` | – | ohne Service routet fly’s Proxy keinen Verkehr; zusammen mit freigegebenen öffentlichen IPs ist die App nicht aus dem Internet erreichbar (ADR 0046) |
| `[env] TAILSCALE_ENABLE`, `TS_HOSTNAME` | `1`, `email-agent` | Entrypoint startet Tailscale (Userspace, als `node`, Zustand in `/data/tailscale`) und `tailscale serve --https=443` → `127.0.0.1:3000` |
| `[env] BIND_ADDRESS` | `0.0.0.0` | der Health-Check erreicht die App über das private fly-Netz („Needs to be available on 0.0.0.0“, https://docs.fly.io/reference/configuration, `checks`) |
| `[env] DATABASE_PATH` | `/data/email-agent.sqlite` | liegt auf dem Volume |
| Auto-Stop/-Start | entfällt | ohne Service stoppt oder startet fly’s Proxy die Maschine nicht; sie läuft dauerhaft (IMAP-IDLE), Not-Aus = `fly machine stop` |
| Health-Check | `GET /api/health` auf Port 3000, Intervall 30 s, Timeout 5 s, Karenz 30 s | top-level `[checks]` (braucht keinen Service und keine öffentliche IP): https://docs.fly.io/reference/configuration |
| `[[vm]]` | `shared-cpu-1x`, `512mb` | gemessen, siehe unten; `size` und `memory`: https://docs.fly.io/launch/scale-machine |
| `[mounts]` | `source = 'email_data'`, `destination = '/data'` | https://docs.fly.io/reference/configuration (`mounts`) |

Die Vorlage aus PR #4 hatte `memory = '1gb'` und `memory_mb = 256` gleichzeitig; jetzt gibt es genau eine Angabe.

### Speicherbedarf (gemessen am 2026-10-31, lokal in Docker, synthetisch)

- Image im Produktionsmodus (`NODE_ENV=production`), keine Konten, also **ohne** IMAP-Worker und ohne Jev; 960 Anfragen (8 parallele Schleifen) auf `/api/health`, `/welcome`, `/api/emails` (401) und `/`.
- `npm start` (Standard-`CMD` für Compose) belegt zusammen 281 MiB laut `docker stats`: Node allein 287 MB RSS, dazu `npm` 96 MB und ein `sh`. Spitze von Node unbegrenzt: 399 MB RSS (V8 wächst, solange Platz da ist), dazu esbuild 24 MB.
- Deshalb startet das fly-Target Node direkt mit `--max-old-space-size=256` (kein `npm`-Wrapper). Mit dem Cap und `--memory=512m` im Container: Spitze **267 MB RSS (Node) + 25 MB (esbuild) = rund 292 MB**, kein OOM.
- Zuschlag, konservativ geschätzt (nicht gemessen, es gab keine Live-Verbindungen): 4 IMAP-Verbindungen mit TLS-Puffern und Header-Parsing rund 20 bis 30 MB, Jev-Aufrufe über `@openrouter/sdk` (Antworten sind klein, wenige parallel) rund 20 bis 40 MB. Erwartete Spitze also etwa 330 bis 360 MB.
- **256 MB reichen nicht:** der Leerlauf liegt schon bei rund 230 bis 270 MB RSS. **512 MB** lassen mit 360 MB Spitze mehr als 30 % Puffer (Grenze 394 MB). Das Linux der VM braucht zusätzlich etwas; deshalb nicht knapper wählen. Nach dem ersten Betrieb mit echten Konten `fly machine status` bzw. das Dashboard (Metriken) ansehen und nachjustieren.

## Volume-Rechte (warum es einen Entrypoint gibt)

- Die offizielle Doku sagt zu Besitzer und Rechten eines neuen Volumes nichts (https://docs.fly.io/volumes/overview). Ein Fly-Mitarbeiter schreibt im Forum: „We automatically `chown` the mount destination of your volume with your docker image's user and group.“ und „if you're dropping privileges in your entrypoint, your volume's mount destination might be owned by `root:root`.“ (https://community.fly.io/t/fly-volumes-getting-permission-denied/1773). Ein weiteres Beispiel, in dem ein Volume als root gemountet war und per `chown` korrigiert wurde: https://community.fly.io/t/no-permission-to-create-directory-in-mounted-volume/3111. Der genaue Modus (die App verlangt 0700, `validateDatabasePath`) ist nirgends belegt, also wird er nie angenommen.
- Lösung: `scripts/docker-entrypoint.sh`. Startet der Container als **root** (fly-Target, kein `USER`), setzt es das Verzeichnis von `DATABASE_PATH` rekursiv auf `node:node`, Modus 0700, macht eine per `ACCOUNTS_FILE` angegebene Datei (z. B. fly-Secret-Datei, root-eigen) für `node` lesbar mit 0600 und wechselt mit `setpriv --reuid=node --regid=node --init-groups` **dauerhaft** auf `node` (`setpriv` ist im Basis-Image `node:26.12.1-slim` vorhanden; Prozess danach uid 1000, keine Capabilities). Verzeichnisse wie `/`, `/etc`, `/app` verweigert es. Startet der Container als `node` (Compose, Docker-Smoke, Standard-Target `app` mit `USER node`), führt es den Befehl unverändert aus. Die Compose-Härtung (`read_only`, `cap_drop: [ALL]`, `no-new-privileges`) bleibt unberührt.
- Dockerfile-Stages: `base` (Build, Entrypoint), `fly` (ohne `USER`, `CMD node ...`), `app` (letzte Stage, `USER node`, Standard für `docker build .`/Compose).

### Lokaler Beleg (fly-artiges, root-eigenes Volume)

```sh
docker build -t email-agent:fly --target fly .
docker volume create fly-rootvol
docker run --rm -v fly-rootvol:/data alpine sh -c 'chown root:root /data && chmod 755 /data'
docker run -d --name fly-probe -e FLY_APP_NAME=email-agent -e APP_PASSWORD=<mindestens 16 Zeichen, nur Test> \
  -e BIND_ADDRESS=0.0.0.0 -e DATABASE_PATH=/data/email-agent.sqlite -v fly-rootvol:/data -p 127.0.0.1:3000:3000 email-agent:fly
curl -s localhost:3000/api/health                                   # {"status":"ok"}
docker exec fly-probe sh -c 'grep ^Uid /proc/1/status; stat -c "%U:%G %a" /data /data/*'
```

Ergebnis (2026-10-31): Uid 1000, `/data` = `node:node 700`, Datenbankdateien `node:node`, `/api/health` 200, `/api/emails` ohne Anmeldung 401. Ohne `APP_PASSWORD` (aber mit `FLY_APP_NAME`) bricht der Start mit `FlyAuthMissingError` ab. Der Docker-Smoke (`npm run smoke:docker`, Compose-Härtung, `USER node`) blieb grün.

## Zugang nur im Tailnet (ADR 0046)

1. **Tailscale-Auth-Key erzeugen** (Tailscale-Admin → Settings → Keys → *Generate auth key*): einmalig verwendbar reicht, weil der Zustand danach auf dem Volume liegt; optional mit Tag (z. B. `tag:email-agent`) und ACL, die nur deine Geräte zulässt. Im Tailnet müssen MagicDNS und HTTPS-Zertifikate aktiv sein.
2. **Als Secret setzen:** `TS_AUTHKEY` im GitHub-Environment `prod` und Workflow „Secrets nach fly“ (oder `fly secrets set TS_AUTHKEY=…` direkt im Terminal, nie in Chat oder Datei).
3. **Öffentliche IPs entfernen:** `fly ips list`, dann `fly ips release <ip> …` für jede öffentliche Adresse (https://docs.fly.io/networking/flycast). Eine neue App mit `fly deploy --no-public-ips` anlegen.
4. **Deployen**, dann im Log `entrypoint: tailscale registered` (erster Start) bzw. `tailscale connected (saved state)` prüfen; die Maschine erscheint als `email-agent` in der Tailscale-Geräteliste.
5. **Öffnen:** `https://email-agent.<tailnet>.ts.net` auf einem Gerät im Tailnet; ohne Tailnet ist die App nicht erreichbar (`https://email-agent.fly.dev` antwortet nicht).
6. Nach erfolgreicher Anmeldung kann der Auth-Key in Tailscale widerrufen und das Secret entfernt werden; der Zustand bleibt auf dem Volume. Geht das Volume verloren, braucht es einen neuen Key.

Grenze: Fällt `tailscaled` aus, bleibt die App für fly gesund (der Check prüft nur die App), ist aber nicht erreichbar. Abhilfe: `fly machine restart`.

## Schritte

Voraussetzung: `flyctl` installiert und per `fly auth login` angemeldet. Der App-Name `email-agent` muss bei fly frei sein; sonst in `fly.toml` ändern.

1. **Passwort bereithalten** (mindestens 16 Zeichen, Passphrase). Ohne es startet die App auf fly nicht.
2. **App anlegen, ohne zu deployen:** `fly apps create email-agent`. Kein `fly launch` (würde `fly.toml` überschreiben).
3. **Volume anlegen** (eins, 1 GB, Region wie in `fly.toml`): `fly volumes create email_data --region fra --size 1`. Ein Volume hängt an genau einer Maschine (https://docs.fly.io/volumes/overview: „A volume can attach to one Machine.“).
4. **Secrets setzen, vor dem ersten Deploy** – aus der lokalen, git-ignorierten Env-Datei (`.env.local`, sonst `.env`; Vorlage `.env.example`):
   ```sh
   make fly-secrets-check     # prüft die Datei, zeigt nur Namen, kontaktiert fly nicht
   make fly-secrets-stage     # erster Deploy: setzen ohne Neustart (es läuft noch keine Machine)
   make fly-secrets-sync      # später: setzen und Machine neu starten
   make fly-secrets-status    # Namen lokal vs. fly (Werte zeigt fly nie, nur Digests)
   make fly-secrets-prune     # wie sync, entfernt zusätzlich auf fly alles, was die Datei nicht sendet
   ```
   Optionen: `ENV_FILE=pfad`, `APP=name`, `FLY=/pfad/zu/fly`, `FORCE=1` (keine Rückfrage), `KEEP=A,B` (bei prune nie entfernen). Direkt: `node scripts/fly-secrets.ts sync [--stage] [--prune] [--keep A,B] [--force]`.
   - **Rückfrage:** Jede Änderung an fly (sync, stage, prune) zeigt vorher, was gesetzt und entfernt wird, und fragt `[y/N]`. Ohne Terminal (CI, Pipe) bricht sie ab, außer mit `--force`/`FORCE=1`. `--force` überspringt nur die Frage, nie die Prüfung (Pflicht-Secrets, Passwortlänge, Platzhalter).
   - **`--prune`:** liest `fly secrets list` und entfernt jedes Secret, das die Datei nicht sendet, z. B. ein lokal gelöschtes `OPENAI_API_KEY` oder Altlasten. Nie entfernt: `ACCOUNTS_JSON` (Konten-Datei als Secret, Option A unten) und `KEEP`-Namen. Ablauf: erst `import --stage`, dann ein `unset`, damit die Machine nur einmal neu startet; scheitert `list` oder `import`, wird nichts entfernt. Das Skript `scripts/fly-secrets.ts` sendet nur Namen aus seinem Katalog: Pflicht `APP_PASSWORD` (≥ 16 Zeichen) und `OPENROUTER_API_KEY`, optional `OPENAI_API_KEY`. Konfiguration wie `BIND_ADDRESS`, `DATABASE_PATH`, `ACCOUNTS_FILE` steht in `fly.toml` und wird nie als Secret gesendet; unbekannte Namen werden übersprungen. Werte gehen nur über stdin an `fly secrets import` (nie als Argument, also nicht in `ps` oder der Shell-Historie) und werden nie ausgegeben. Jeder Wert wird als `"""…"""` übergeben, weil flyctl Werte sonst beim ersten `#` abschneidet und Anführungszeichen entfernt (flyctl `internal/command/secrets/parser.go`); Platzhalter (`REPLACE_ME`), mehrzeilige Werte und zu kurze Passwörter brechen ab, ohne etwas zu senden. Secrets entfernt das Skript nur mit `--prune`.

   **Nicht ins Git-Repo:** Auch verschlüsselt oder in einem privaten Repo gehören Secrets nicht in die Historie (H1, `CLAUDE.md`). Quelle der Wahrheit ist die lokale Env-Datei (zusätzlich im Passwortmanager sichern), fly hält die Kopie für den Betrieb.
5. **Konten-Datei (IMAP-Zugänge) erst hochladen, wenn der Passwortschutz nachweislich läuft** (Startseite zeigt das Passwortfeld, `/api/emails` ohne Anmeldung liefert 401). Optionen:

   | Option | Ablauf | Bewertung |
   |---|---|---|
   | A. Secret als Datei | `fly secrets set ACCOUNTS_JSON="$(base64 < accounts.json)"`, in `fly.toml` `[[files]] guest_path = '/run/secrets/accounts.json'`, `secret_name = 'ACCOUNTS_JSON'` und `[env] ACCOUNTS_FILE = '/run/secrets/accounts.json'` (https://docs.fly.io/reference/configuration, Abschnitt `files`; Wert muss base64 sein). | Bevorzugt: verschlüsselt abgelegt, nicht auf dem Volume, nicht in Snapshots, nicht im Repo. Der Entrypoint stellt Besitzer `node` und 0600 her. Änderungen: Secret neu setzen (löst Neustart/Deploy aus). Dafür muss `fly.toml` um die zwei Einträge ergänzt werden (bewusst nicht vorab drin, damit der erste Deploy ohne Konten läuft). |
   | B. Datei auf dem Volume | `fly ssh sftp shell` bzw. `fly ssh console`, Datei nach `/data/accounts.json`, danach `ACCOUNTS_FILE=/data/accounts.json` in `[env]`. | Einfach zu ändern, aber die Zugangsdaten liegen unverschlüsselt auf dem Volume und damit **in jedem Snapshot**. Nur wenn A nicht passt; Modus 0600 und Besitzer `node` setzt der Entrypoint beim nächsten Start. |
   | C. Ohne Konten | nichts hochladen | Die App läuft ohne IMAP-Worker (nur Oberfläche); sinnvoll für den ersten Deploy. |

   Mailinhalte werden nirgends gespeichert; die Datenbank enthält nur Metadaten.
6. **Deployen:** `fly deploy` (Build mit dem Target `fly`, Remote-Builder).
7. **Auf eine Maschine begrenzen:** `fly scale count 1`. Beim ersten Deploy kann fly sonst zwei Maschinen anlegen; ein Volume hängt an genau einer, und zwei Instanzen würden IMAP doppelt bedienen. Prüfen mit `fly status` und `fly volumes list`.
8. **Prüfen:** `https://email-agent.<tailnet>.ts.net/api/health` → `{"status":"ok"}`; Startseite öffnen, anmelden (ersten Admin vorher per `user:create` anlegen, `docs/qa/BLOCKERS.md` B6). `https://<app>.fly.dev` darf nicht antworten.

## GitHub Environments und Workflows

Entscheidung: ADR 0024. Anleitung mit allen Namen und Schritten: `docs/github-environments.md`.

- **`prod`** (Required reviewer: Nico): Workflow `.github/workflows/secrets-to-fly.yml` (nur `workflow_dispatch`) ruft `node scripts/fly-secrets.ts sync --from-env --profile prod --force` auf (`--stage` bei Eingabe `stage = true`). Die Environment-Secrets kommen als Umgebungsvariablen in den Schritt, das Skript sendet sie nur über stdin an `fly secrets import`; im Log stehen Namen. `--profile prod` macht `ACCOUNTS_ENCRYPTION_KEY`, `VAPID_PUBLIC_KEY` und `VAPID_PRIVATE_KEY` zur Pflicht; `VAPID_SUBJECT` und `OPENAI_API_KEY` sind für das Skript optional; Web-Push (ADR 0036) bleibt aber ohne `VAPID_SUBJECT` aus. Schlüsselpaar: `npm run push:keys`. Ohne `--profile` (lokal, Preview) sind die neuen Schlüssel optional, werden aber geprüft, wenn sie gesetzt sind.
- **`preview`**: Workflow `.github/workflows/preview-app.yml` (`deploy` oder `destroy`) legt `email-agent-preview-<suffix>` aus `fly.preview.toml` an, setzt die Preview-Secrets (vorgemerkt) und deployt; `destroy` löscht die App. Die Preview hat kein Volume (die Datenbank liegt auf der Machine und wird bei jedem Start neu befüllt), keine Konten-Datei und damit keine IMAP-Worker. `PREVIEW_SEED_SYNTHETIC=1` (nur in `fly.preview.toml`) lässt `scripts/docker-entrypoint.sh` den synthetischen Mini-Satz einspielen (`scripts/seed-preview.ts`, dasselbe Set wie `npm run smoke:e2e`, kein Netz, kein Jev); das Skript verweigert jede App, die nicht mit `email-agent-preview-` beginnt.
- Handarbeit bleibt möglich: `make fly-secrets-*` mit lokaler Env-Datei (ADR 0024, dev).
- Aktionen: `actions/checkout@v7`, `actions/setup-node@v7` (wie in `ci.yml`), `superfly/flyctl-actions/setup-flyctl` auf den Commit des Tags `1.6` gepinnt, flyctl `0.5.1`. Die Eingabe `version` ist in der `action.yml` des Tags belegt. Der Befehl `fly secrets import` liest laut flyctl-Quelltext stdin; `fly deploy --ha=false --remote-only --yes --config` und `fly apps destroy --yes` sind in der flyctl-Doku (Context7 `/superfly/flyctl`) bzw. den Flag-Definitionen belegt.

## Kosten (nur belegte Preise)

Quelle: https://docs.fly.io/about/pricing (abgerufen 2026-10-31, USD). Die Seite nennt keine Preise für `fra` bei 256/512 MB (nur: „Machine prices vary by region“); die genannten Zahlen gelten für die günstigsten Regionen `iad`/`ewr`. Für `fra` ist nur die 1-GB-Stufe belegt: `shared-cpu-1x` mit 1 GB kostet dort 7,73 USD im Monat gegenüber 6,70 USD in `iad`. Die Preisliste der Region `fra` vor dem Deploy prüfen.

- `shared-cpu-1x`, 512 MB: 3,69 USD im Monat (`iad`/`ewr`), sekundengenau, solange die Maschine läuft (hier: immer).
- Volume: 0,15 USD je GB und Monat bereitgestellter Größe, also 0,15 USD für 1 GB, auch bei gestoppter Maschine.
- Volume-Snapshots: 0,08 USD je GB und Monat nach tatsächlich belegtem Speicher, die ersten 10 GB je Monat frei.
- Gemeinsame IPv4/IPv6-Adressen und eingehender Datenverkehr kostenlos; ausgehender Verkehr aus `fra`: 0,02 USD/GB. Neue Organisationen haben keine allgemeine Gratisstufe (Test: bis zu 2 Stunden Laufzeit bzw. 7 Tage).
- Größenordnung aus den belegten `iad`-Preisen: rund 3,84 USD im Monat (3,69 + 0,15) plus Aufschlag für `fra` und Verkehr. Kein belegter Gesamtpreis.

## Not-Aus und Backup

- **Not-Aus (sofort):** `fly machine stop <machine-id>` (ID aus `fly status`). `auto_start_machines = false` sorgt dafür, dass eine Anfrage die Maschine nicht wieder startet. Wieder an: `fly machine start <machine-id>`. Nur die automatischen Postfach-Aktionen anhalten: Datei `auto-actions.disabled` neben der Datenbank anlegen (`fly ssh console -C "touch /data/auto-actions.disabled"`), siehe Handover; Passwort ändern: `fly secrets set APP_PASSWORD=...` (startet die Maschine neu). Bestehende Sitzungen enden nach dieser Beschreibung erst, wenn das Sitzungsgeheimnis (`auth-secret` im Datenverzeichnis, siehe README) wechselt; im Zweifel die Datei löschen und neu starten (nicht live geprüft).
- **Snapshots:** fly legt täglich Snapshots an; Aufbewahrung laut https://docs.fly.io/volumes/overview von 1 bis 60 Tagen einstellbar, Standard 5 Tage. Auflisten: `fly volumes snapshots list <volume-id>`; sofort einen anlegen: `fly volumes snapshots create <volume-id>` (https://docs.fly.io/volumes/snapshots).
- **Wiederherstellen** in ein neues Volume: `fly volumes create email_data --snapshot-id <snapshot-id> --region fra` (https://docs.fly.io/getting-started/troubleshooting). Danach Maschine auf das neue Volume umhängen bzw. neu deployen; Besitzer/Rechte setzt der Entrypoint beim Start.
- Alles löschen: `fly apps destroy email-agent` (löscht auch das Volume; vorher Snapshot bzw. Kopie der SQLite-Datei sichern).

## Postfächer in der App (R2): Schlüssel und Import
Seit R2 liegen Postfach-Passwörter verschlüsselt in der Datenbank (`docs/accounts-contract.md`). Vor dem ersten Start einer R2-Version, die eine Konten-Datei findet (`ACCOUNTS_FILE`, Optionen A/B oben), muss `ACCOUNTS_ENCRYPTION_KEY` als Secret gesetzt sein (`docs/github-environments.md`, Profil `prod`). Der Start importiert die Datei dann einmalig (Log: `legacy accounts file imported: N account(s)`), danach wird sie nie wieder gelesen und kann samt Secret `ACCOUNTS_JSON` entfernt werden. Ohne Schlüssel startet der Server trotzdem, aber ohne Postfach-Worker (Profil zeigt „Schlüssel fehlt“); die Datei wird dann weder gelesen noch markiert.
