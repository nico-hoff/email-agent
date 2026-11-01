# Nachweise zur Zielbedingung (GOAL.md)

> Erzeugt am 2026-11-01 19:45 auf `b91abb6` durch ein Skript: ADR-Zeilen per grep aus `docs/adr/`, Code-Zeilen per grep, Tests per `node --test`. Keine Handangaben.

## 1. ADR-Kernforderung (Wortlaut) → Code → Tests

### R1 Nutzerkonten
- ADR 0022: "Registrierung im MVP nur per Einladung** (Einladungscode vom Admin). Erster Admin per CLI (`npm run user:create`) bzw. im Dev automatisch als Testnutzer."
- Code: `lib/profile-api.ts: 41:  if (me.role !== "admin") return json({ error: "forbidden" }, 403);`
- Tests (tests/users.test.ts tests/auth-users.test.ts tests/tenant-isolation.test.ts tests/users-mode-server.test.ts tests/user-cli.test.ts): 107 bestanden / 0 fehlgeschlagen

### R1 Trennung pro Nutzer
- ADR 0022: "Mehrnutzerfähiges Datenmodell:** jede nutzerbezogene Tabelle bekommt `user_id`; jede Abfrage filtert danach (zentral in `lib/`, Tests prüfen die Trennung)."
- Code: `lib/tenant.ts: 24:  return db.prepare("SELECT 1 FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?")`
- Tests (tests/tenant-isolation.test.ts): 33 bestanden / 0 fehlgeschlagen

### R2 Verschlüsselung
- ADR 0023: "Tabelle `mail_accounts` (pro `user_id`): Typ, Anzeigename, Farbe, Host/Port/TLS, Benutzername, **Geheimnis verschlüsselt** (AES-256-GCM, zufälliger Nonce, `key_id` für Rotation), Status, Einstellungen."
- Code: `lib/account-secrets.ts: 64:  const cipher = createCipheriv("aes-256-gcm", ring.current.bytes, nonce, { authTagLength: TAG_BYTES });`
- Tests (tests/account-secrets.test.ts tests/mail-accounts.test.ts tests/accounts-api.test.ts): 54 bestanden / 0 fehlgeschlagen

### R2 fail-closed
- ADR 0023: "Schlüssel `ACCOUNTS_ENCRYPTION_KEY` (32 Byte, base64) nur als Secret: prod auf fly, dev in `.env.local`. Nie im Repo, nie im Log, nie in der API. Fehlt der Schlüssel, startet der Worker keine Konten (fail-closed)."
- Code: `lib/account-secrets.ts: 16:export type KeyringResult = { ok: true; keyring: Keyring } | { ok: false; code: "no_encryption_key" };`
- Tests (tests/account-secrets.test.ts): 12 bestanden / 0 fehlgeschlagen

### R2 Erst-Import ohne Aktionen
- ADR 0043: "**Keine Postfach-Aktionen für importierte Mails:** `createMailboxActions.evaluate` gibt für `origin = 'import'` `imported` zurück (in jedem Modus, auch live) und der Start-Backfill überspringt sie. Absender-Statistik, Jev-Spam-Zähler und HITL laufen normal."
- Code: `lib/mailbox-actions.ts: 185:    if (mail.origin === "import") return { outcome: "imported" };`
- Tests (tests/initial-import.test.ts): 17 bestanden / 0 fehlgeschlagen

### R3 standardmäßig aus, nur Nutzer
- ADR 0025: "Pro Postfach in den Profil-Einstellungen, **standardmäßig aus**, nur der Nutzer selbst schaltet um (Agenten nie):"
- Code: `lib/settings-api.ts: 151:  if (mode === "live" && confirm !== true) return json({ error: "confirmation_required" }, 400);`
- Tests (tests/settings-api.test.ts tests/mailbox-actions.test.ts tests/classifier-model.test.ts): 58 bestanden / 0 fehlgeschlagen

### R4 Secrets → fly
- ADR 0024: "prod:** Quelle sind die verschlüsselten Secrets des GitHub-Environments `prod` (Repo-Einstellungen, nicht Repo-Inhalt). Ein manueller Workflow (`workflow_dispatch`, Environment `prod` mit Freigabe durch Nico) übergibt si"
- Code: `.github/workflows/secrets-to-fly.yml: 19:    environment: prod`
- Tests (tests/fly-secrets.test.ts tests/workflows.test.ts tests/seed-preview.test.ts): 35 bestanden / 0 fehlgeschlagen

### R6 nur Metadaten
- ADR 0027: "Web-Push (VAPID) für die PWA: Abo pro Gerät und Nutzer, Benachrichtigung bei neuer wichtiger Mail und wenn das Briefing bereitsteht. Inhalt nur Metadaten auf Minimum (z. B. „2 wichtige Mails“, optional Absendername), nie"
- Code: `lib/push.ts: 52:export interface PushPayload { v: 1; kind: PayloadKind; count: number }`
- Tests (tests/push.test.ts tests/push-api.test.ts tests/push-crypto.test.ts tests/push-ui.test.ts tests/pwa.test.ts): 73 bestanden / 0 fehlgeschlagen

### R7 Kalibrierung, synthetisch
- ADR 0028: "Agenten dürfen für R&D live aufrufen (Jev-Proben, Evals, Agenten-Proben), **nur mit synthetischen Inhalten** (HF-Datensets, eigene Fixtures). Nie mit echten Mails, nie IMAP auf echte Postfächer, nie `live`-Schaltung von "
- Code: `lib/constants.ts: 26:export const QUESTION_SET_VERSION = QUESTION_SET_VERSION_V2;`
- Tests (tests/noul-calibration.test.ts tests/jev-questions.test.ts tests/calibration-report.test.ts): 47 bestanden / 0 fehlgeschlagen

### R8 Themen-Choice mit Listenversion
- ADR 0026: "Die Optionsliste wird pro Nutzer gebaut und mit Version gespeichert; Änderung der eigenen Liste ⇒ neue Listenversion."
- Code: `lib/classification-pipeline.ts: 58:      ctx.db.prepare("UPDATE classifications SET topic_list_version = ? WHERE id = ?").run(ctx.topicListVersion, ctx.`
- Tests (tests/topics.test.ts tests/topics-store.test.ts tests/topics-api.test.ts tests/topics-pipeline.test.ts tests/topics-gate.test.ts tests/topics-ui.test.ts): 60 bestanden / 0 fehlgeschlagen

### R9 nie EXPUNGE, nur Schreibport
- ADR 0025: "Grenzen: nie `EXPUNGE`/endgültiges Löschen; alles nur über den Schreibport (`lib/imap-write.ts`, erweitert um `move`), UIDVALIDITY-Prüfung, Rücklesen, `mailbox_actions`-Protokoll, Undo (zurückverschieben), Tageslimit, No"
- Code: `lib/imap-write.ts: 182:      if (!client.capabilities.has("MOVE")) throw new ImapWriteError("move_unsupported");`
- Tests (tests/imap-write-move.test.ts tests/imap-write.test.ts tests/quarantine-actions.test.ts tests/action-undo-route.test.ts): 61 bestanden / 0 fehlgeschlagen

- R9 Zusatz: Treffer für Delete/EXPUNGE/Copy/Append in `lib/imap-write.ts`: 0

## 2. Screenshots je QA-Paket und erzeugender Lauf

- **R1**: 5 Bilder (R1-menu-profil.png R1-profile-invite-created.png R1-profile.png R1-welcome-login.png R1-welcome-register.png ). Quelle laut Paket: "Stand 2026-10-31, Branch `dev`. Screenshots (synthetische Daten, 390x844): `docs/qa/img/R1-*.png`."
- **R2**: 4 Bilder (R2-konten-liste.png R2-konto-erweitert.png R2-konto-hinzufuegen-google.png R2-verbindungstest.png ). Quelle laut Paket: "Stand 2026-10-31, Branch `wt/r2`. Screenshots (synthetischer Dev-Modus, 390x844): `docs/qa/img/R2-*.png`. Vertrag: `docs/accounts-contract.md`."
- **R3**: 5 Bilder (R3-aktionen.png R3-berechtigungen.png R3-live-dialog.png R3-modell.png R3-not-aus.png ). Quelle laut Paket: "Stand 2026-11-01, Branch `wt/r3`. Screenshots (synthetischer QA-Server, 390x844): `docs/qa/img/R3-*.png`. Verträge: `docs/accounts-contract.md` (Abschnitt „Einstellungen im Profil“), `docs/imap-write-"
- **R6**: 5 Bilder (R6-push-aktiv.png R6-push-aus.png R6-push-blockiert.png R6-push-ios-installieren.png R6-push-nicht-verfuegbar-dunkel.png ). Quelle laut Paket: "Die QA-Umgebung hat im Headless-Browser keinen echten Push-Dienst. Für „Aus/An/blockiert/iPhone“ ersetzt ein Testskript nur die Browser-Objekte (`PushManager`, `Notification`, `serviceWorker.ready`) d"
- **R7**: 2 Bilder (R7-detail-v2.png R7-liste-v2.png ). Quelle laut Paket: "`docs/qa/img/R7-liste-v2.png`: Liste im synthetischen Dev-Modus mit 24 v2-klassifizierten HF-Mails (Seed 11): „Offen 21 von 24“, Karten mit Wichtigkeit und Dringlichkeit. Das ist die sichtbare Folge d" Zweites Bild R7-detail-v2.png: in dieser Sitzung auf dem synthetischen QA-Server erzeugt (`npm run qa:serve`, Port 3600).
- **R8**: 7 Bilder (R8-liste-ohne-themen.png R8-liste-ordner-gefiltert-dunkel.png R8-liste-ordner.png R8-profil-thema-editor.png R8-profil-themen-an.png R8-profil-themen-aus.png R8-profil-themen-zwei.png ). Quelle laut Paket: "Screenshots (390x844, synthetische QA-Daten; Themen-Antworten per Skript simuliert)"
- **R9**: 5 Bilder (R9-aktionen.png R9-einstellungen.png R9-live-dialog.png R9-undo.png R9-yolo-warnung.png ). Quelle laut Paket: "Stand 2026-11-01, Branch `wt/r9`. Screenshots (synthetischer QA-Server, 390x844): `docs/qa/img/R9-*.png`. Verträge: `docs/imap-write-contract.md` Abschnitt 7, `docs/accounts-contract.md`."
- **initial-import**: 8 Bilder (sync-1-verbinden-dark.png sync-1-verbinden.png sync-2-lesen.png sync-3-klassifizieren.png sync-4-klassifizieren-spaeter-dark.png sync-4-klassifizieren-spaeter.png sync-5-fertig-dark.png sync-5-fertig.png ). Quelle laut Paket: "node scripts/sync-sim.ts --port 3410            # eigener Port, eigene DB data/sync-sim.sqlite"
- **R4**: keine Oberfläche; Nachweis per Workflow-Lauf durch Nico, mit Grund in `docs/qa/BLOCKERS.md` (B1–B4).
- Daten in allen Bildern: nur `*.example.test` / `synthetic.invalid`; Zahl echter Domains in den QA-Paketen: 0

## 3. Gelesene Einstiegsdokumente (SHA-256, Stand dieser Prüfung)

- `docs/GOAL.md` 47 Zeilen, bb25ff66a963
- `CLAUDE.md` 28 Zeilen, 8b04eebbcb5b
- `AGENTS.md` 46 Zeilen, 77b8662e3f59
- `docs/README.md` 51 Zeilen, 7265fc9295ba
- `docs/HANDOVER_2026-11-01.md` 68 Zeilen, c5e022462de1
- `docs/ROADMAP.md` 43 Zeilen, 7ba327ba4c82
- `docs/ARCHITECTURE.md` 161 Zeilen, 2476f4ba19ce
- `docs/adr/0021-environments-deploy-gate.md` 23 Zeilen, 62258981d1a3
- `docs/adr/0022-user-accounts-iam.md` 20 Zeilen, cdedd8145321
- `docs/adr/0023-encrypted-mail-accounts.md` 20 Zeilen, 25f7f880814e
- `docs/adr/0024-secrets-per-environment.md` 18 Zeilen, 3354c9170503
- `docs/adr/0025-mailbox-actions-user-settings.md` 21 Zeilen, 2be072ab7a6e
- `docs/adr/0026-topics-jev-choice.md` 16 Zeilen, f6c308a1b062
- `docs/adr/0027-web-push.md` 14 Zeilen, b3c81ad71331
- `docs/adr/0028-rnd-live-calls.md` 14 Zeilen, de4fc09cf371
- `docs/erd.md` 778 Zeilen, 91ceec830590
- `docs/access-contract.md` 89 Zeilen, f311a83dce81
- `docs/accounts-contract.md` 67 Zeilen, 51dbe72d8616
- `docs/agent-contract.md` 134 Zeilen, 92bcf8ac5fa1
- `docs/imap-write-contract.md` 84 Zeilen, 94ea4f07c0bb
- `docs/jev-contract.md` 179 Zeilen, 6a989528473f

## 4. Status

- `dev` = `origin/dev` = `b91abb6`; Gate und Docker-Smoke grün auf diesem Stand (siehe Sitzungsprotokoll); `main` unberührt.
