# GitHub Environments und Workflows (ADR 0024)

Anleitung für Nico. Es steht kein Secret-Wert in dieser Datei und keiner im Repo; die Werte liegen nur in den GitHub-Environments. Agenten sehen sie nie.

Überblick:

| Environment | Zweck | Workflow | Freigabe |
|---|---|---|---|
| `prod` | echte App `email-agent` auf fly | `Secrets nach fly (prod)` (`.github/workflows/secrets-to-fly.yml`) | Required reviewer: Nico |
| `preview` | kurzlebige Preview-Apps `email-agent-preview-<suffix>`, nur synthetische Daten | `Preview-App` (`.github/workflows/preview-app.yml`) | keine nötig |

Beide Workflows laufen nur per `workflow_dispatch` (von Hand), mit `permissions: contents: read`. Im Log stehen nur Secret-Namen.

## 1. Environments anlegen

GitHub, Repo `email-agent` → **Settings** → **Environments** → **New environment**.

1. Name `prod` → *Configure environment*.
   - **Required reviewers** anhaken, dich selbst eintragen, *Save protection rules*. Danach wartet jeder Lauf des Prod-Workflows auf deinen Klick „Approve and deploy“.
   - Optional **Deployment branches and tags** → *Selected branches* → `main`. Dann kann der Workflow nur von `main` aus mit den Prod-Secrets laufen. Ohne diese Einschränkung wählst du beim Start den Branch frei.
2. Name `preview` → *Configure environment*. Keine Schutzregel nötig (nur synthetische Werte), optional wie oben auf `dev` und `main` beschränken.

## 2. Secrets eintragen

Pro Environment: **Environment secrets** → *Add environment secret*. Namen exakt wie unten (Großbuchstaben). Repository-weite Secrets werden nicht verwendet.

### Environment `prod`

| Name | Pflicht | Woher der Wert |
|---|---|---|
| `FLY_API_TOKEN` | ja | Deploy-Token nur für die App `email-agent`: im Terminal `fly tokens create deploy -a email-agent` (der Token wird einmal angezeigt; nicht in Chat oder Datei kopieren, direkt in das GitHub-Feld einfügen). |
| `APP_PASSWORD` | ja (bis die Benutzerkonten aus R1 stehen) | Passphrase, mindestens 16 Zeichen, z. B. aus dem Passwort-Manager. |
| `OPENROUTER_API_KEY` | ja | OpenRouter-Dashboard → Keys; ein eigener Schlüssel für prod mit Limit. |
| `ACCOUNTS_ENCRYPTION_KEY` | ja | `openssl rand -base64 32` (32 Byte, base64; das Skript prüft das Format, ohne den Wert zu zeigen). **Einmal erzeugen und sicher sichern** (Passwort-Manager): ohne diesen Schlüssel sind gespeicherte Postfach-Zugangsdaten nicht mehr lesbar. Nicht ohne Not rotieren. |
| `VAPID_PUBLIC_KEY` | ja | `npx web-push generate-vapid-keys` (Paket `web-push`, wird per npx geladen, nichts im Repo). Ausgabe „Public Key“ (base64url, 65 Byte). |
| `VAPID_PRIVATE_KEY` | ja | Dieselbe Ausgabe, „Private Key“ (base64url, 32 Byte). Public und Private gehören zusammen, nicht mischen. |
| `VAPID_SUBJECT` | nein (vorerst) | `mailto:deine@adresse` oder `https://…`. Leer lassen ist erlaubt. |
| `OPENAI_API_KEY` | nein | Nur falls die Agenten direkt zu OpenAI sollen. Leer lassen = nicht gesetzt. |

Fehlt ein Pflichtwert oder hat er das falsche Format, bricht der Workflow ab, **bevor** fly kontaktiert wird (Namen und Grund im Log, nie der Wert).

### Environment `preview`

| Name | Pflicht | Woher der Wert |
|---|---|---|
| `FLY_API_TOKEN` | ja | Die Preview-Workflow legt Apps an und löscht sie; das kann ein App-Deploy-Token nicht. Org-Token: `fly tokens create org -o <org>`. Besser eine **eigene fly-Organisation nur für Previews**, damit der Token nie an `email-agent` (prod) kommt. |
| `APP_PASSWORD` | ja | Beliebige Test-Passphrase, mindestens 16 Zeichen, **nicht** das Prod-Passwort. |
| `OPENROUTER_API_KEY` | ja | Der Dev-Schlüssel mit gesetztem Limit (ADR 0028), nicht der Prod-Schlüssel. In der Preview laufen keine IMAP-Worker, also entsteht ohne Zutun kein Jev-Aufruf. |

Weitere Secrets braucht die Preview nicht (keine Konten-Datei, kein Push).

## 3. Workflows starten

GitHub → **Actions** → Workflow links wählen → **Run workflow**.

### „Secrets nach fly (prod)“

1. Branch wählen (`main`, siehe Hinweis oben), Eingabe `stage`:
   - `false`: Secrets setzen, fly startet die Machine neu.
   - `true`: nur vormerken, wirkt beim nächsten `fly deploy`.
2. Lauf öffnen → **Review deployments** → `prod` anhaken → *Approve and deploy*.
3. Log prüfen: Plan mit Namen, `Gesendet: …`. Mit `fly secrets list -a email-agent` (nur Namen/Digests) gegenprüfen.

Das Skript setzt die Secrets; es löscht keine (kein `--prune`). Die App-Datei `fly.toml` bleibt maßgeblich für den App-Namen.

### „Preview-App“

- **deploy**: `action` = `deploy`, `suffix` z. B. `r4` → App `email-agent-preview-r4`. Der Workflow legt sie an (falls neu), setzt die Secrets des Environments `preview` (vorgemerkt), deployt den gewählten Branch mit `fly.preview.toml` und füllt beim Start die leere Datenbank mit dem eingebauten synthetischen Satz (`PREVIEW_SEED_SYNTHETIC=1`). Aufruf: `https://email-agent-preview-<suffix>.fly.dev`, Anmeldung mit dem Passwort aus dem Environment `preview`.
- **destroy**: `action` = `destroy`, gleiches `suffix` → App samt Maschine wird gelöscht. Previews nach dem Test immer löschen.
- Suffix: nur `a-z`, `0-9`, `-`, 1 bis 20 Zeichen. Der Workflow kann nur Apps mit dem Präfix `email-agent-preview-` anlegen oder löschen.

## 4. Was nicht passiert

- Kein Lauf ohne deinen Klick (`workflow_dispatch`, bei `prod` zusätzlich die Freigabe).
- Keine Konten-Datei, keine echten Postfächer, kein IMAP in der Preview; die Daten sind der eingebaute synthetische Satz (siehe `docs/qa/R4.md`).
- Der Prod-Deploy der App selbst bleibt der automatische Deploy bei Push auf `main` (ADR 0021); der Secrets-Workflow ändert nur Secrets.
