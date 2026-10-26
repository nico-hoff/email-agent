# Iteration 2: Notizen und Backlog

> **Status:** Sammlung, kein verbindlicher Plan. Grundlage für `docs/IMPLEMENTATION_PLAN_v4.md`, der **erst nach dem Freigabepunkt** (Abschnitt 7 in `docs/IMPLEMENTATION_PLAN.md`) mit echten Sample-Ergebnissen geschrieben wird. Bis dahin gelten Plan v3 und seine Nicht-Ziele unverändert.
>
> Stand: 2026-10-26, nach T22 (Commit `e4f1f36`).

## 0. Voraussetzung: Freigabepunkt (Nico, manuell)

1. `docs/accounts.json` nach `data/accounts.json` verschieben, `chmod 600` (Vorlage: `docs/accounts.example.json`). Echten Spam-Ordnernamen per IMAP-LIST eintragen. Zuerst nur das web.de-Testkonto aktivieren.
2. Datenweitergabe bestätigen: bis zu 400 gekürzte Auszüge samt Absender/Betreff gehen an OpenRouter. Vorher Datenschutz-/Logging-Einstellungen des OpenRouter-Accounts prüfen.
3. `npm run sample -- --account <id> --limit-per-folder 200` (Vorschau), dann `… --confirm <N>`.
4. `npm run dev`, Dashboard prüfen: Jev gegen Provider-Ordner, `security_auth`, Phishing, `addresses_an_ai`, `needs_my_reply`, `is_assessable`, Urgency/Importance, Modell/Latenz, `shadow_quarantine`.
5. Danach als Kontrolle das Custom-Domain-Konto.

**Ergebnisse, die Iteration 2 braucht** (bitte festhalten, nur aggregiert, keine Mailinhalte):
- Verteilung der `noul`-Rohwerte für `is_spam`, `needs_my_reply`, `is_assessable`, getrennt nach Provider-Ordner (INBOX vs. Spam).
- Anzahl und Art der Abweichungen (`provider_spam_jev_not_spam`, `jev_spam_provider_not_spam`).
- Entscheidung zur `security_auth`-Policy (D11).
- Was auf dem Handy wirklich gebraucht wird (Abweichungen prüfen? täglicher Digest? nur „needs reply“?).

### Erstes Sample (2026-10-26, Konto `web2`, nur aggregiert)

168 ausgewählt (INBOX 6, Spam 162), 159 klassifiziert, 9 übersprungen (doppelte Message-IDs im Spam-Ordner), 0 Fehler, Ø Latenz 225 ms. Shadow: 159 × `unmapped_answer` (erwartet, fail-closed).

| Frage | INBOX (n=6) Median / Max | Spam (n=153) Min / p10 / Median | Spam ≥ 0.5 |
|---|---|---|---|
| `is_spam` | 0.44 / 0.65 | 0.64 / 0.87 / 0.93 | 153/153 |
| `is_phishing_or_scam` | 0.30 / 0.95 (3/6 ≥ 0.5) | 0.04 / 0.33 / 0.69 | 131/153 |
| `needs_my_reply` | 0.53 / 0.96 | 0.17 / 0.64 / 0.86 | 143/153 |
| `is_assessable` | 0.93 / 0.94 | 0.06 / 0.27 / 0.78 | 132/153 |
| `addresses_an_ai` | 0.02 / 0.04 | 0.02 / 0.02 / 0.02 | 0/153 |

Kategorien: INBOX `security_auth` 4, `transactional` 2; Spam `spam` 78, `newsletter_promo` 74, `transactional` 1.

Erste Lesart (vorläufig, n klein):
- `is_spam` trennt hier gut: alle Spam-Ordner-Mails ≥ 0.64, INBOX max 0.65. Eine Schwelle um 0.8–0.85 wäre ein Kandidat, braucht aber mehr legitime Mails (Custom-Domain-Konto).
- `is_phishing_or_scam` schlägt bei Sicherheits-/Login-Mails im Posteingang an (3/6 ≥ 0.5). Das ist genau der D11-Fall: `security_auth` darf nie allein über Phishing-/Spam-Werte entschieden werden.
- `needs_my_reply` ist bei Spam fast immer hoch und als Sicherheitsbremse in der Shadow-Regel so **nicht** brauchbar; Formulierung im Fragenset v2 schärfen oder anders gewichten.
- `addresses_an_ai` ist durchweg niedrig (kein Injection-Fall in dieser Stichprobe).

## 1. Kalibrierung: Schwellen und Shadow-Regel

- `interpretNoul` liefert heute immer `unmapped` (fail-closed), daher ist `shadow_quarantine.candidate` immer `false`. Beobachtet: offensichtliche Werbung bekam `is_spam` 0.74–0.82, `needs_my_reply` 0.83 bei Werbung. Die Rohwerte sind also keine sauberen Wahrscheinlichkeiten.
- Aus den Sample-Daten je `noul`-Frage eine belegte Regel ableiten (Schwelle, ggf. je Konto über `spam_threshold`) und in `docs/jev-contract.md` dokumentieren, **bevor** `interpretNoul` sie nutzt.
- `security_auth`-Policy umsetzen (D11): z. B. nie Quarantäne für Login-Codes und Passwort-Resets, unabhängig vom Spam-Wert.
- Neues Fragenset nur als neue `QUESTION_SET_VERSION` (z. B. `email-classification-v2`); der Bestand bleibt erhalten, `sample --question-set` wertet neu aus (`sample` erlaubt heute nur die im Code vorhandene Version).

## 2. Evals mit Veryfront (`veryfront/eval`)

Context7 (`/websites/veryfront`), Stand heute:
- `evalAgent` testet Agenten aus `agents/` (`target: "agent:<id>"`). Der einzige dokumentierte Live-Adapter ist `createAgentServiceEvalAdapter` (AG-UI). Für eine normale SDK-Funktion wie `systemOneCreate` gibt es keinen.
- `evalDataset` bewertet gespeicherte Werte ohne Agent: `input` des Beispiels wird zu `record.output`. Metriken: `metrics.answer.exactMatch/contains/regex/jsonMatch`, `metrics.judge.rubric`, `metrics.ops.latency/tokens/cost`; `.gate()` (hart) vs. `.budget()` (Grenze; fehlende Messung = nicht bestanden). Ausführung per `veryfront eval [id]` bzw. `runEval(def, { adapters: {} })`, Bericht mit `summary.passRate`.

Vorschlag:
- **E1 (klein, jederzeit möglich):** `eval:jev` schreibt die normalisierten Antworten des synthetischen Sets als Dataset, `evals/jev-email-v1.eval.ts` bewertet sie per `evalDataset` + `jsonMatch`. So gibt es Standard-Reports und `npm run eval` offline in CI, ohne Jev als Chat-Agent zu tarnen. Nur synthetische Daten (H3).
- **E2:** Eval-Set erweitern (schwierigere Fälle, Grenzfälle wie Rechnung vs. Rechnungsbetrug, gemischte Sprachen), Schwellen-Varianten vergleichen.
- **E3:** Für den späteren Antwort-Agenten `evalAgent` mit `metrics.agent.notCalledTool(...)` (keine Seiteneffekte), LLM-Judge für Entwurfsqualität und Budgets für Kosten und Latenz.

## 3. Agents und Tools (`agents/`, `tools/`)

Context7 (`/websites/veryfront`):
- Agent: `agent({ id, system, model?, tools?, maxSteps?, outputSchema?, delegates?, providerTools?, mcpServers?, memory?, security? })` aus `veryfront/agent`, alternativ Markdown (`agents/<id>.md` mit Frontmatter). Aufruf über `getAgent("<id>")`.
- Tool: `tool({ description, inputSchema: defineSchema(v => …)(), execute, outputSchema? })` aus `veryfront/tool`; der Dateiname ist die ID. Ein Agent sieht nur explizit freigegebene Tools. Tools in `tools/` sind automatisch auch per MCP erreichbar.

Vorschlag:
- **A0 Aufräumen:** CLI-Skripte `tools/sample.ts` und `tools/eval-jev.ts` nach `scripts/` verschieben (npm-Scripts anpassen), damit `tools/` nur echte Veryfront-Tools enthält.
- **A1 Antwort-Agent** (der „GPT-6-Luna-Agent“ aus dem Blueprint): erzeugt nur **Entwürfe** als strukturierte Ausgabe (`outputSchema`), zunächst nur zur Anzeige in der UI, nicht als IMAP-Draft.
  - Harte Regel: Mails mit `addresses_an_ai` positiv oder `unmapped` gehen **nie** an den Agenten.
  - `security` nicht abschalten; `maxSteps` klein; kein `memory` über Mails hinweg.
  - Nur eng gefasste Lese-Tools (z. B. „Metadaten und Klassifikation zu Mail X“, „gekürzter Auszug zu Mail X“ im Speicher), keine Schreib-Tools.
  - Modellwahl und Datenweitergabe gesondert freigeben.
- Jev bleibt laut D3 außerhalb von `agents/`; ein Agent darf Jev-Ergebnisse höchstens über ein Lese-Tool sehen.

## 4. Mobile Review-UI (iPhone)

Heute: `app/page.tsx` ist eine minimale React-Client-Komponente (Tabelle, Kontofilter, Antworten, Shadow, Abweichungen, Workerstatus), nur über `127.0.0.1` erreichbar, ohne Auth.

**M1 Zugang zuerst (Voraussetzung, sicherheitskritisch).** Das Dashboard zeigt Absender und Betreff echter Mails.
- Erreichbarkeit nur für eigene Geräte, z. B. Tailscale (kein offener Port), später der Pi im Heimnetz.
- Authentifizierung (z. B. Passkey/WebAuthn oder Tailscale-Identität), HTTPS, Rate-Limits, Session-Handling.
- D12 („nur `127.0.0.1`“) wird dafür bewusst und dokumentiert abgelöst; Compose-/Bind-Konfiguration entsprechend.

**M2 Mobiles Layout + PWA.**
- Karten statt Tabelle, Detailansicht je Mail, Filter als Segmented Control (Konto, Status, nur Abweichungen, nur „needs reply“).
- Safe-Area-Ränder, Dark Mode, große Touch-Ziele, schnelle erste Ansicht (paginierte `/api/emails`).
- Web-App-Manifest und Icon für „Zum Home-Bildschirm“; Push-Benachrichtigungen erst mit Telegram oder Web Push entscheiden.
- Weiterhin nie Body, Auszug oder Rohheader in der API (Marker-Test aus T19 beibehalten).

**M3 Aktionen (erst mit Schreibpfaden, siehe 5).** Z. B. „Spam bestätigen / ablehnen“ als Feedback in die DB (kein IMAP-Write), später „Policy anwenden“.

## 5. Mailbox-Aktionen (erst nach expliziter Freigabe)

- Reihenfolge: Feedback nur in der DB → Quarantäne-Ordner (Move) für ein Testkonto → Ausweitung.
- Erfordert: neues `ImapPort`-Interface mit getrennten Schreibmethoden, eigene Tests, Audit je Aktion, Kill-Switch, Dry-Run-Modus; `security_auth`-Policy und kalibrierte Schwellen sind Pflicht.
- Nie löschen ohne Quarantäne-Zwischenschritt.

## 6. Technische Schulden und Aufräumen

- `node_modules/` ist historisch im Repo getrackt (Starter-Überrest): `git rm -r --cached node_modules` in einem eigenen Commit.
- `HANDOVER.md` (untracked, überholt): archivieren oder löschen, nach Nicos Entscheidung.
- Status-Route: cwd-unabhängiger Test fehlt (nur `PROJECT_ROOT` ist getestet).
- `createService` registriert Signal-Handler ohne Entfernen beim `stop()` (für Mehrfach-Instanzen in Skripten `onSignal` injizieren).
- `npm run build` bündelt die API-Routen nicht; `node:sqlite` in Routen ist nur über Dev-Smoke und Tests belegt. Im Container (`npm start`) einmal explizit prüfen, dass `/api/emails` mit Daten funktioniert.
- `server.ts` importiert `@veryfront/ext-bundler-esbuild` (transitive Abhängigkeit): bei Veryfront-Updates prüfen.
- Colima/Docker: Die Konten-Datei für Compose muss unter `$HOME` liegen (`/var/folders` wird nicht gemountet).
- Commit-Trailer waren teils uneinheitlich (Haiku/Sonnet statt Opus); nicht korrigierbar ohne Amend, nur zur Kenntnis.

## 7. Später (unverändert aus Plan v3, nicht Teil von Iteration 2 ohne Entscheidung)

Telegram, Gmail-OAuth, Raspberry Pi/systemd-Deployment, Second-Brain-Anbindung.

## Vorgeschlagene Reihenfolge für Plan v4

1. Freigabepunkt-Ergebnisse auswerten → Kalibrierung (Abschnitt 1) + E1.
2. A0 Aufräumen + technische Schulden (Abschnitt 6).
3. M1 Zugang + M2 Mobile-UI.
4. A1 Antwort-Agent (nur Entwürfe in der UI) + E3.
5. Mailbox-Aktionen (Abschnitt 5) nur nach expliziter Freigabe.
