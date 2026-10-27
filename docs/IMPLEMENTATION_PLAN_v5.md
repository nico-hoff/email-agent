# Plan v5 – Produktkern: ein Postfach für alles, nur Signal

> **Status: Konzept (2026-10-27), offene Fragen F1–F5 von Nico beantwortet (Abschnitt 2.3); Freigabe zur Umsetzung steht aus.** Grundlage: Nicos Akzeptanzkriterien vom 2026-10-27, Stand nach Plan v4 (`docs/HANDOVER_2026-10-27.md`). Regeln aus v3 (Abschnitt 3) und v4 (H11–H15) gelten weiter; dieser Plan ergänzt sie um H16–H22 und ersetzt H2 erst ab Meilenstein M7, und nur dort.
> Offene v4-Tasks (T26–T28, T31, T35, T37, T42–T45) gehen in die Meilensteine unten auf und behalten ihre Nummern.

## 1. Zielbild (Nicos Akzeptanzkriterien)

1. **Eine App aufs Handy:** mobile Web-App, als Icon auf dem Home-Bildschirm (PWA), erreichbar nur über Nicos Tailnet.
2. **Ein Postfach statt vier:** Mails aller Konten in einer Liste. Das Konto ist nur ein kleiner farbiger Tag; ob eine Mail von web.de oder der Custom Domain kommt, ist zweitrangig.
3. **Alles vorsortiert:** Jede Mail ist kategorisiert, nach Dringlichkeit und Wichtigkeit gewichtet und landet in **App-Ordnern**, die es nur in der App gibt (thematisch bzw. fokusbasiert, z. B. „Arbeit“, „Finanzen“, „Familie“).
4. **Eigene Ordner:** Nico legt Ordner im App-Menü an, benennt sie um, löscht sie. Ein Knopf lässt den Agenten aus einer Stichprobe der letzten zwei Wochen Ordner vorschlagen. Jev sortiert danach direkt in diese Ordner.
5. **Nur Signal:** Startansicht zeigt Relevantes, sortiert nach Dringlichkeit. Spam, Newsletter und Statistik sind eingeklappt bzw. zweitrangig.
6. **Spam verschwindet von selbst:** Sehr sicherer Spam wird automatisch als gelesen markiert und in einen **Quarantäne-Ordner** verschoben. Absender, die Nico als Müll markiert hat (**eigene Blacklist**), dürfen bei sehr hoher Sicherheit automatisch gelöscht werden.
7. **Briefing beim Öffnen:** Beim Öffnen der App erscheint oben sofort, live gestreamt, ein kurzes Briefing (ca. 3 Bullet Points: was passiert ist, was wichtig ist, was wartet).
8. **Agent schreibt nur, wenn gefragt:** Entwürfe auf Knopfdruck; kein Chat nötig.

**Nicht-Ziele v5:** Senden von Mails, IMAP-Entwürfe, Chat-Oberfläche, öffentliche Erreichbarkeit, Gmail-OAuth, Telegram. Raspberry-Pi-Betrieb ist optional (M8).

## 2. Entscheidungen

### 2.1 Von Nico entschieden (2026-10-27)

| ID | Entscheidung |
|---|---|
| E1 | **Quarantäne-Ordner** statt Löschen für automatisch erkannten Spam: verschieben + als gelesen markieren. |
| E2 | **Eigene Blacklist:** Absender, die Nico als Müll markiert hat, dürfen automatisch gelöscht werden – nur bei sehr hoher Sicherheit **und** Blacklist-Eintrag („Nico hat schon x-mal gesagt: Müll“). |
| E3 | **App-Ordner = feste Themen**, verwaltet in einer eigenen Tabelle; Nico legt sie im App-Menü an, ändert und löscht sie. |
| E4 | **Ordner-Vorschläge per Knopf:** Agent zieht eine Zufallsstichprobe der letzten zwei Wochen und schlägt Ordner vor; Nico übernimmt sie. Jev ordnet danach direkt in diese Ordner ein („semi-flexible“ Kategorien). |
| E5 | **Briefing beim Öffnen**, sofort ausgelöst, live gestreamt, ca. 3 Bullet Points, später anpassbar. |
| E6 | Alle Agenten weiter auf `openai/gpt-6-luna` über OpenRouter (O1a). |
| E7 | **HITL für Absender (F1):** Hat Jev denselben Absender dreimal als Spam eingestuft, fragt die App Nico einmal. Nicos Entscheidung gilt **dauerhaft**: Blacklist (darf künftig automatisch gelöscht werden) oder Whitelist (wird nie aussortiert). Bis zur Entscheidung gelten nur die normalen Quarantäne-Regeln. |
| E8 | **Adresse oder Domain (F2)** hängt von der Menge ab: Kommen die Spam-Urteile von mehreren Adressen derselben Domain, schlägt die App die Domain vor, sonst die Adresse. Nico bestätigt im selben HITL-Dialog. |
| E9 | **Betrieb 24/7 per Docker (F3):** auf dem Mac, einem eigenen Rechner oder ggf. fly.io. Das Container-Setup bleibt gleich; Zugang weiterhin nur übers Tailnet. |
| E10 | **Höchstens 12 Themen-Ordner (F4)** zusätzlich zu den System-Ordnern. Jede Mail bekommt genau ein Thema (Jev-Choice). |
| E12 | **Spam wird per IMAP als gelesen markiert** (`\Seen`), damit auch der Mailserver und jede andere Mail-App ihn als gelesen führt. Gilt für alles, was Spam ist – von Jev erkannt oder vom Provider in den Spam-Ordner sortiert. Erste und kleinste Schreibstufe (M7a), vor Quarantäne und Löschen. |
| E11 | **Briefing = alles Offene (F5):** alles, was ungelesen oder nicht erledigt ist **und** eine Handlungsaufforderung (CTA) hat. Spam ist automatisch „gelesen“ und kommt nicht vor. Kein fester Zeitraum. |

### 2.2 Vorschläge, die mit der Freigabe dieses Plans gelten

| ID | Vorschlag | Begründung |
|---|---|---|
| D22 | **„Löschen“ heißt Verschieben in den Papierkorb des Providers**, nie endgültiges Löschen (`EXPUNGE`). | Rückholbar (Provider halten den Papierkorb meist 30 Tage). |
| D23 | Quarantäne-Ordner pro Konto; Name in der Konten-Datei (`quarantine_mailbox`). Die App legt keine Ordner selbst an; Nico legt ihn einmal an (Vorschau prüft ihn wie heute den Spam-Ordner). | Kleinste Schreibfläche. |
| D24 | Automatisches Leeren der Quarantäne nach 30 Tagen (in den Papierkorb), abschaltbar. | „Nur Signal“, trotzdem rückholbar. |
| D25 | Ordner-Kategorien gehen **nicht über den State**, sondern als Antwortoptionen der Kategorie-Frage an Jev (Choice-Frage: Optionen = Ordner, Kriterien = Ordnerbeschreibungen). Der State bekommt nur strukturierten Absender-Kontext (Zahlen). | So ist die Antwort garantiert einer der Ordner; Freitext im State wäre Prompt-Injection-Fläche. |
| D26 | Jede Änderung der Ordnerliste erzeugt eine neue **Ordner-Set-Version**; die letzten 14 Tage werden im Hintergrund neu eingeordnet (Kosten ca. 0,00005 $/Mail). | Ordner bleiben konsistent, alte Antworten erhalten. |
| D27 | Briefing und Ordner-Vorschläge sehen **nur Metadaten** (Absenderdomain, Betreff, Ordner, Dringlichkeit, Wichtigkeit, ausgeführte Aktionen), nie Mailtexte. Betreffs sind als nicht vertrauenswürdig gezäunt; Mails mit `addresses_an_ai` positiv oder unmapped gehen nur als Anzahl ein. | Datenschutz und Prompt-Injection. |
| D28 | Briefing und Vorschläge werden nicht gespeichert (wie D17); nur ein Audit mit Zahlen. Gegen doppelte Aufrufe beim Neuladen: Ergebnis 5 Minuten im Arbeitsspeicher. | |
| D29 | Kontofarbe und Kurzname stehen in der Konten-Datei (`label`, neu `color`). | Kein Schema nötig, Nico pflegt sie ohnehin dort. |

### 2.3 Beantwortete Fragen (2026-10-27)

| ID | Frage | Antwort |
|---|---|---|
| F1 | Wann wird ein Absender Blacklist-Kandidat? | Nach 3 Spam-Urteilen von Jev → HITL, Entscheidung dauerhaft (E7). |
| F2 | Adresse oder Domain? | Abhängig von der Anzahl betroffener Adressen (E8). |
| F3 | Betrieb? | 24/7 per Docker, Ort offen (Mac, eigener Rechner, ggf. fly.io) (E9). |
| F4 | Wie viele Ordner? | 12 Themen (E10); Jev-Grenze für Choice-Optionen vor T51 per Doku/Probe bestätigen. |
| F5 | Briefing-Umfang? | Alles Offene mit CTA, unabhängig vom Zeitraum (E11). |

## 3. Konzepte

### 3.1 Signal-Postfach (Startansicht „Wichtig“)

- Eine Liste über alle Konten, sortiert nach **Dringlichkeit → Wichtigkeit → Zeit**.
- Oben: Briefing (M6). Darunter: „Wichtig“ (alles außer Spam, Newsletter, Quarantäne), dann eingeklappte Abschnitte „Newsletter & Werbung“ und „Aussortiert“ mit Anzahl.
- Karte: Konto-Farbpunkt + Kurzname (klein), Ordner-Chip, Dringlichkeit; Spam-Wahrscheinlichkeit nur im Detail.
- Navigation unten oder als Seitenleiste: App-Ordner mit Zählern, „Quarantäne“, Einstellungen.

### 3.2 App-Ordner (semi-flexible Kategorien)

- Tabelle `folders` (siehe 4). System-Ordner, die nicht löschbar sind: „Sicherheit & Login“ (`security_auth`), „Spam“, „Newsletter & Werbung“, „Sonstiges“. Nutzer-Ordner: frei.
- Jev-Kategorie-Frage wird aus der Ordnertabelle gebaut (D25). Die Version des Fragensets setzt sich aus Basis (`email-classification-v2`) und Ordner-Set-Version zusammen; die Kalibrierung gilt je Basisversion.
- **Vorschlagsknopf:** Zufallsstichprobe (geschichtet nach Konto, max. 150 Mails der letzten 14 Tage, nur Metadaten) → `gpt-6-luna` mit `outputSchema` `{ folders: [{ name, description, example_count }] }` → Vorschauliste in der App → Nico übernimmt, ändert oder verwirft.

### 3.3 Absender-Regeln (Blacklist und Allowlist)

- Tabelle `sender_rules`: Blacklist („Müll, darf gelöscht werden“) und Allowlist („nie aussortieren“), je Adresse oder Domain, optional je Konto.
- Feedback-Knöpfe in der App (T37): „ist Spam“, „kein Spam“, „falscher Ordner → …“, „braucht Antwort“, „braucht keine Antwort“, „Absender immer aussortieren“.
- **HITL-Auslöser (E7/E8):** Erreicht `senders.jev_spam_count` für eine Adresse (bzw. summiert für eine Domain) den Wert 3 und gibt es noch keine Regel, erscheint in der App eine Karte „Absender X wurde 3× als Spam erkannt – immer aussortieren (Blacklist) oder nie (Whitelist)?“, mit Vorschlag Adresse oder Domain. Die Antwort wird als `sender_rules`-Eintrag mit `source='nico'` gespeichert und gilt dauerhaft, bis Nico sie in den Einstellungen ändert.
- Feedback fließt dreifach ein: (a) Labels für die Kalibrierung, (b) Zähler für den HITL-Auslöser, (c) **reine Zähler** im Jev-State (`sender_history.user_marked_spam`, `user_marked_not_spam`), nur wenn DMARC bestanden hat.

### 3.4 Automatische Aktionen (ab M7, einziger Schreibpfad)

Reihenfolge der Prüfung je neu klassifizierter Mail; die erste passende Regel gewinnt. Ab M7 übernehmen Blacklist und Quarantäne das Markieren als gelesen gleich mit; die Regel „Spam gelesen“ greift dann nur noch für Spam, der weder in den Papierkorb noch in die Quarantäne geht:

| Regel | Bedingungen (alle) | Aktion |
|---|---|---|
| Schutz | Kategorie `security_auth` **oder** `transactional` **oder** Allowlist-Treffer | nichts |
| Spam gelesen (E12, ab M7a) | Jev `is_spam` positiv (kalibriert, v1: ≥ 0.80) **oder** Mail liegt im Spam-Ordner des Providers und Jev sagt nicht ausdrücklich „kein Spam“ | nur als gelesen markieren (`\Seen`), nicht verschieben |
| Blacklist | Blacklist-Treffer **und** `is_spam` ≥ Schwelle „sehr hoch“ (kalibriert, Startvorschlag 0.95) | als gelesen markieren + in den Papierkorb verschieben (D22) |
| Quarantäne | `is_spam` ≥ Quarantäne-Schwelle **und** `needs_my_reply` negativ **und** `is_assessable` positiv | als gelesen markieren + in den Quarantäne-Ordner verschieben |
| sonst | | nichts (nur App-Ordner) |

- **Trockenlauf zuerst:** mindestens 7 Tage nur protokollieren, was passiert *wäre*; die App zeigt es im Ordner „Würde aussortieren“. Scharfschalten pro Konto durch Nico.
- **Not-Aus** global und pro Konto, **Tageslimit** pro Konto, **Rückgängig** in der App (zurück in die INBOX, Flag entfernen) für Quarantäne und Papierkorb.
- Jede Aktion ein Eintrag in `mailbox_actions` und ein Audit-Eintrag; nie Inhalte.

### 3.5 Briefing beim Öffnen

- UI ruft nach dem Login `POST /api/briefing` (Auth, CSRF, Rate-Limit). Die Route baut den Kontext (D27), ruft einen eigenen Agenten `briefing` (`agents/briefing.ts`, gleiche Sperren wie D19: keine Tools außer Lesen, kein Memory) mit `agent.stream()` auf und streamt den Text per SSE in einen Kasten oben in der UI.
- Inhalt (E11): alle **offenen** Mails mit CTA (siehe 3.6), dringendste zuerst, in höchstens 3 Bullet Points; dazu eine Zeile, was seit dem letzten Öffnen automatisch aussortiert wurde, und offene HITL-Fragen (E7). Ton und Länge später in den Einstellungen anpassbar.
- `user_state.last_opened_at` merkt den Zeitpunkt; Ergebnis 5 Minuten im Speicher (D28).
- Veryfront-`tasks/` (`veryfront/task`) dienen nur Hintergrundjobs (Quarantäne leeren, Neu-Einordnen nach Ordneränderung), nicht dem Streaming. Vor Umsetzung per Context7 verifizieren (H6).

### 3.6 Offen und erledigt

- Eine Mail ist **offen**, wenn sie eine Handlungsaufforderung hat (`needs_my_reply` positiv oder Jev-`route` ∈ {`draft_reply`, `notify`}) **und** weder gelesen noch erledigt ist.
- **Gelesen** kommt vom Provider: das IMAP-Flag `\Seen` wird beim Abruf mitgelesen (nur lesend; heute holt der Abruf nur Header) und bei IDLE/Polling aktualisiert.
- **Erledigt** setzt Nico in der App (Wischgeste oder Knopf) – nur in der App-DB, ohne IMAP-Schreibzugriff. Rückgängig jederzeit.
- Automatisch aussortierte Mails sind gelesen (Quarantäne/Papierkorb setzen `\Seen`) und damit nie offen.

## 4. Datenmodell (Entwurf, vor Umsetzung in `docs/erd.md`, je Meilenstein eine Migration)

```sql
-- 002 (M4): App-Ordner
CREATE TABLE folders (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,            -- stabiler Schlüssel, Jev-Option
  name        TEXT NOT NULL,
  description TEXT NOT NULL,                   -- Kriterium für Jev
  color       TEXT,
  position    INTEGER NOT NULL,
  system      INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  source      TEXT NOT NULL CHECK (source IN ('system', 'nico', 'agent_suggestion')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE folder_sets (                     -- Version der Ordnerliste (D26)
  version     TEXT PRIMARY KEY,
  folder_keys_json TEXT NOT NULL CHECK (json_valid(folder_keys_json)),
  created_at  TEXT NOT NULL
);

-- 003 (M5): Feedback (T37) und Absender
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY, email_id INTEGER NOT NULL REFERENCES emails (id),
  classification_id INTEGER REFERENCES classifications (id),
  kind TEXT NOT NULL, value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
  actor TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE senders (                         -- „welche Domains/Absender es gibt“
  id INTEGER PRIMARY KEY, address TEXT NOT NULL, domain TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  mails_seen INTEGER NOT NULL DEFAULT 0, marked_spam INTEGER NOT NULL DEFAULT 0,
  marked_not_spam INTEGER NOT NULL DEFAULT 0, jev_spam_count INTEGER NOT NULL DEFAULT 0,
  hitl_asked_at TEXT, dmarc_pass INTEGER NOT NULL DEFAULT 0,
  UNIQUE (address)
);
CREATE TABLE sender_rules (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('blacklist', 'allowlist')),
  match TEXT NOT NULL CHECK (match IN ('address', 'domain')), value TEXT NOT NULL,
  account_id TEXT REFERENCES accounts (id), source TEXT NOT NULL CHECK (source IN ('nico', 'suggested_confirmed')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE (kind, match, value, account_id)
);

-- 003b (M2): Lese- und Erledigt-Status (3.6)
CREATE TABLE email_status (
  email_id INTEGER PRIMARY KEY REFERENCES emails (id),
  seen INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0, 1)),      -- vom Provider (\\Seen), nur gelesen
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),      -- von Nico in der App
  updated_at TEXT NOT NULL
);

-- 004 (M6/M7): App-Zustand und Postfach-Aktionen
CREATE TABLE user_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK (json_valid(value_json)), updated_at TEXT NOT NULL);
CREATE TABLE mailbox_actions (
  id INTEGER PRIMARY KEY, email_id INTEGER NOT NULL REFERENCES emails (id),
  location_id INTEGER NOT NULL REFERENCES email_locations (id),
  rule TEXT NOT NULL CHECK (rule IN ('blacklist', 'quarantine', 'purge', 'undo')),
  action TEXT NOT NULL CHECK (action IN ('move_quarantine', 'move_trash', 'mark_seen', 'move_inbox', 'unmark_seen')),
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'live')),
  status TEXT NOT NULL CHECK (status IN ('planned', 'done', 'failed', 'undone')),
  failure_code TEXT, reason_json TEXT NOT NULL CHECK (json_valid(reason_json)),
  created_at TEXT NOT NULL, done_at TEXT
);
```

Spaltennamen-Allowlist und Marker-Test (kein `body|snippet|excerpt|raw|…`) gelten weiter. `audit_log.actor` braucht ggf. neue Werte (`nico`, `rules`) → in der ERD dokumentieren.

## 5. Neue harte Regeln

- **H16 Schreibpfad nur über `ImapWritePort`:** getrennt vom Lese-Port, Methoden nur `moveTo(folder)`, `addSeen`, `removeSeen`, nie `expunge`/`delete`/`append`/`send`. Ein Test belegt, dass außerhalb von `lib/mailbox-actions.ts` niemand den Schreib-Port erzeugt.
- **H17 Schutzregeln zuerst:** `security_auth`, `transactional` und Allowlist werden vor jeder Aktion geprüft; ein Test pro Regel, dass keine Aktion entsteht, egal wie hoch die Spam-Werte sind.
- **H16a:** In M7a darf der Schreib-Port ausschließlich `\Seen` setzen und entfernen; ein Test belegt, dass `moveTo` erst ab M7 existiert.
- **H18 Trockenlauf ist Standard:** `live` nur pro Konto mit ausdrücklichem Schalter in der Konten-Datei; Not-Aus und Tageslimit in jedem Pfad getestet.
- **H19 Jede Aktion rückgängig machbar** (außer der Provider leert den Papierkorb); Undo ist ein Test-Pflichtfall.
- **H20 Agenten sehen nur Metadaten** (Briefing, Ordner-Vorschläge); Entwürfe (T42) bleiben die einzige Ausnahme mit frischem Auszug (D18/D19).
- **H21 Keine Freitext-Injektion in Jev:** State nur strukturiert (Zahlen, Booleans, kurze Codes); Ordnerbeschreibungen sind Nico-Text, gehen als Kriterien, nicht als Anweisung.
- **H22 Live-Aufrufe:** Wie H14; jede neue Agent-Funktion bekommt genau eine synthetische Live-Probe, Evals offline in CI.

## 6. Meilensteine

Commit-Präfix weiter `phase N: …`, Phasen ab 11. Jeder Meilenstein endet mit einer Vorführung auf dem iPhone (H15) und einem kurzen Bericht.

### M1 – Live auf dem Handy (Phase 11)
| Task | Inhalt | Wer |
|---|---|---|
| T31 | Tailscale-Probe: `tailscale serve --bg 3000`, iPhone im Tailnet, Allowlist, Login; prüfen, dass `Host` durchkommt | Nico |
| T46 | Echtbetrieb auf dem Mac: `npm start` bzw. Compose mit echten Konten, Worker an, Autostart (launchd) dokumentieren | Agent + Nico |
| T47 | Konto-Tags: `color` in der Konten-Datei (D29), Farbpunkt + Kurzname auf Karten und im Filter | Agent |
| T38b | PWA auf dem iPhone installieren und prüfen (Icon, Start ohne Browser-Leiste, Login bleibt bestehen) | Nico |
**Fertig, wenn:** Nico öffnet die App vom Home-Bildschirm und sieht seine echten Mails aller Konten.

### M2 – Signal-Postfach (Phase 12)
| Task | Inhalt |
|---|---|
| T35 | Mobile-API: Cursor-Pagination, `view=important|noise|all|folder:<key>`, Sortierung Dringlichkeit → Wichtigkeit → Zeit, `GET /api/emails/:id` mit Ordnerverlauf |
| T48 | Startansicht „Wichtig“ mit eingeklappten Abschnitten „Newsletter & Werbung“ und „Aussortiert“, Ordner-Navigation mit Zählern |
| T49 | Detailansicht aufräumen: Wesentliches oben, Jev-Rohwerte und Statistik in „Details“ |
| T64 | Offen/Erledigt (3.6): `\Seen` beim Abruf mitlesen (ImapFlow `flags`, nur lesend), Tabelle `email_status`, „Erledigt“ per Wischgeste/Knopf, Ansicht „Offen“ |
**Fertig, wenn:** Die Startansicht zeigt nur Relevantes, sortiert nach Dringlichkeit; Spam und Newsletter sind ein Tipp entfernt.

### M3 – Fragenset v2 und echte Kalibrierung (Phase 13, parallel zu M2)
| Task | Inhalt |
|---|---|
| T26 | `email-classification-v2`: `needs_my_reply` scharf (persönliche Bitte vs. Marketing-CTA), Phishing vs. legitime Sicherheitsmail; schwierige synthetische Eval-Fälle (DE/EN); 1 Live-Fixture |
| T23/T28 | Nico: Kontroll-Sample Custom-Domain-Konto, Neu-Auswertung mit v2 |
| T25b | Schwellen v2 aus `insights-calib.md` + `npm run calibrate`: `is_spam` (Quarantäne und „sehr hoch“), `needs_my_reply`, `is_assessable` |
| T27 | `npm run eval` offline in CI (Veryfront `evalDataset`) als Gate für Fragenset- und Schwellenänderungen |
**Fertig, wenn:** Alle für 3.4 nötigen Fragen sind kalibriert; „Braucht Antwort“ ist aktiv.

### M4 – Eigene App-Ordner (Phase 14, nach M3)
| Task | Inhalt |
|---|---|
| T50 | ERD + Migration `002` (`folders`, `folder_sets`); System-Ordner als Seed |
| T51 | Kategorie-Frage aus der Ordnertabelle bauen (D25), Versionierung (D26), Neu-Einordnung der letzten 14 Tage als Veryfront-Task; Jev-Grenze für Optionen per Doku/Probe prüfen (F4) |
| T52 | Einstellungen in der App: Ordner anlegen, umbenennen, Beschreibung, Farbe, Reihenfolge, löschen (POST mit Auth/CSRF/Rate-Limit) |
| T53 | Vorschlagsknopf: Stichprobe 14 Tage (nur Metadaten, D27), Agent `folder-suggester` mit `outputSchema`, Vorschauliste, Übernahme; 1 synthetische Live-Probe, Eval mit synthetischen Postfächern |
**Fertig, wenn:** Nico legt einen Ordner „Steuer“ an, und neue Mails landen dort; der Vorschlagsknopf liefert brauchbare Ordner.

### M5 – Feedback und Absender-Regeln (Phase 15, nach M2)
| Task | Inhalt |
|---|---|
| T37 | ERD + Migration `003` (`feedback`, `senders`, `sender_rules`); Feedback-Knöpfe im Detail und per Wischgeste |
| T54 | Absender-Seite: Blacklist/Whitelist ansehen, anlegen, entfernen; HITL-Karte nach 3 Jev-Spam-Urteilen (E7) mit Vorschlag Adresse/Domain (E8) |
| T55 | Feedback-Zähler im Jev-State (`sender_history`), nur bei DMARC pass; Eval vorher/nachher |
| T24b | `npm run calibrate` rechnet Feedback als Label ein |
**Fertig, wenn:** „ist Spam“ verbessert sichtbar die nächste Mail desselben Absenders; Blacklist-Einträge existieren (noch ohne Aktion).

### M6 – Briefing und Entwürfe (Phase 16, nach M2)
| Task | Inhalt |
|---|---|
| T56 | Briefing: `agents/briefing.ts`, `POST /api/briefing` mit `agent.stream()` → SSE, Kasten oben in der UI, `user_state.last_opened_at` (Migration `004` Teil 1), 5-Min-Cache; Context7 zu `agent.stream()`/SSE vorher |
| T42 | „Entwurf erzeugen“: POST-Route + UI (Kopieren-Knopf), H11/H12 |
| T43 | Agent-Evals für Briefing und Entwürfe (Injection-Fälle in Betreffs, Judge für „nur Signal“, Kosten/Latenz-Budgets) |
**Fertig, wenn:** Beim Öffnen erscheinen innerhalb weniger Sekunden 3 sinnvolle Bullet Points; Entwürfe kommen auf Knopfdruck.

### M7a – Spam als gelesen markieren (Phase 17a, nach M2)

Kleinste Schreibstufe (E12): nur `\Seen` setzen, nichts verschieben. Braucht weder Fragenset v2 noch Feedback, deshalb früh.

| Task | Inhalt |
|---|---|
| T57 | ERD + Migration (`mailbox_actions`); `ImapWritePort` (H16), in dieser Stufe nur `addSeen`/`removeSeen`; Context7 `/postalsys/imapflow` zu `messageFlagsAdd`/`messageFlagsRemove` und Mailbox-Locks (Postfach dafür nicht read-only öffnen, aber nur in diesem Modul) |
| T58a | Regel-Engine mit Schutz (H17) und Regel „Spam gelesen“ als reine Funktion; Tests je Regel |
| T59a | Trockenlauf 2–3 Tage: Ansicht „Würde als gelesen markieren“ in der App |
| T60a | Live-Schalter pro Konto, Not-Aus, Tageslimit, Undo („wieder ungelesen“) in der App |
**Fertig, wenn:** Neu eingehender Spam steht auf dem Mailserver als gelesen; ein Tipp in der App macht es rückgängig.

### M7 – Quarantäne und Blacklist-Löschen (Phase 17, nach M3, M5 und M7a)
| Task | Inhalt |
|---|---|
| T57b | `ImapWritePort` um `moveTo(folder)` erweitern; Context7 `/postalsys/imapflow` zu `messageMove` |
| T58 | Regel-Engine 3.4 um Blacklist und Quarantäne erweitern; Tests je Regel, Schutz zuerst (H17) |
| T59 | Trockenlauf: Aktionen nur `planned`, Ordner „Würde aussortieren“ in der App, Tagesbericht im Briefing |
| T60 | Live-Schalter pro Konto, Not-Aus, Tageslimit, Undo in der App (H18, H19); Quarantäne-Aufräumen nach 30 Tagen als Veryfront-Task (D24) |
| T61 | Nico: 7 Tage Trockenlauf prüfen, dann pro Konto scharf schalten |
**Fertig, wenn:** Sicherer Spam ist nach Eingang ohne Zutun gelesen und in der Quarantäne; Blacklist-Müll im Papierkorb; jede Aktion ist rückgängig machbar.

### M8 – Betrieb und Freigabe v5 (Phase 18)
| Task | Inhalt |
|---|---|
| T44 | E2E-Smoke (synthetisch): Login, Liste, Ordner, Feedback, Briefing (Fake-Agent), Entwurf, Trockenlauf-Aktion, Undo |
| T62 | Backups der SQLite-DB, Log-Rotation, Gesundheitsanzeige in der App (Worker-Status je Konto) |
| T63 | 24/7-Betrieb per Docker (E9): Zielort festlegen (Mac, eigener Rechner oder fly.io). Für fly.io vorher klären: Tailscale im Container statt öffentlicher Ports, Secrets über `fly secrets`, SQLite auf persistentem Volume mit Backup, Datenstandort der Mail-Metadaten. |
| T45 | Freigabepunkt v5 (STOP-7): Bericht, Screenshots, Kosten pro Tag |

## 7. Abhängigkeiten und Parallelisierung

```
M1 (Nico + T46/T47) ──────────────────────────────────────────────────────┐
M2 (T35, T48, T49, T64) ──┬─► M7a (Spam gelesen) ──────────┐               │
                          ├─► M5 (T37, T54, T55) ──────────┼─► M7 ─► M8 ◄─┘
                          └─► M6 (T56, T42, T43)           │
M3 (T26, T23/T28, T25b, T27) ──► M4 (T50–T53)              │
                          └────────────────────────────────┘
```

- **Sofort startbar ohne Entscheidung:** M2 komplett, T47, T26 (ohne Live-Fixture), T27.
- **Braucht Nico:** M1 (Tailscale, Echtbetrieb), T23/T28 (Samples), Live-Fixtures/Proben, F1–F5 vor M4/M5/M7.
- **Erste Postfach-Aktion:** M7a (Spam als gelesen) direkt nach M2.
- **Kritischer Pfad für Quarantäne/Löschen:** M3 → M5 → M7.

## 8. Risiken

- **Falsch aussortierte echte Mail:** Gegenmittel Schutzregeln, Precision-first-Schwellen aus echten Daten, 7 Tage Trockenlauf, Undo, Papierkorb statt Löschen.
- **Absender-Spoofing gegen die Blacklist:** Gefälschte Absender treffen nur Müll; echte Mails desselben Absenders schützen `transactional`/`security_auth` und die Allowlist.
- **Prompt-Injection über Betreffs** (Briefing, Vorschläge): Zaun, nur Metadaten, `addresses_an_ai`-Mails nur als Zahl, Evals mit Injection-Fällen.
- **Ordner-Drift:** Jede Ordneränderung = neue Version + Neu-Einordnung; Eval-Gate (T27) vor Änderungen am Fragenset.
- **Betriebsort:** Bis T63 läuft alles auf dem Mac; schläft er, gibt es keine neuen Mails/Aktionen (Worker-Status in der App, T62). Bei fly.io liegen Mail-Metadaten und IMAP-Zugangsdaten bei einem Cloud-Anbieter; die App darf dort nur übers Tailnet erreichbar sein.
- **Kosten:** Jev ≈ 0,00005 $/Mail; Briefing und Entwürfe auf `gpt-6-luna` (0,10/0,50 $ pro Mio. Tokens) pro Aufruf im Bereich von Zehntel-Cent. Tagesbudget in M8 messen.

## 9. Definition of Done v5

Nico nutzt die App täglich vom iPhone-Home-Bildschirm: ein Postfach über alle Konten mit Konto-Tags, eigene Ordner, Startansicht nur mit Relevantem nach Dringlichkeit, Briefing beim Öffnen, Entwürfe auf Knopfdruck, Feedback und Absender-Regeln, und sicherer Spam verschwindet automatisch in Quarantäne bzw. Papierkorb – rückholbar, protokolliert, mit Not-Aus. Typecheck, Suite, Build, `npm run eval` und E2E-Smoke sind grün.
