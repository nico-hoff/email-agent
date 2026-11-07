# IMAP-Schreibvertrag für M7a („Spam als gelesen“)

> Stand 2026-10-27, `imapflow` 2.9.1. Quellen: Context7 `/postalsys/imapflow`, installierte Quellen unter `node_modules/imapflow/dist/esm` (Dateiangaben unten). Recherche ohne Verbindung zu echten Mailservern. Grundlage für T57/T58a–T60a in `docs/IMPLEMENTATION_PLAN_v5.md` (E12, H16, H16a).

## 1. Lesen bleibt strikt lesend (T64)

- Flags lesen: `fetch(range, { uid: true, flags: true })` liefert `flags?: Set<string>` (`types.d.ts:627-628`); `fast`/`all` enthalten `flags` ebenfalls (`commands/fetch.js:81, 91`).
- Inhaltsabrufe nutzen `BODY.PEEK`/`BINARY.PEEK` (`commands/fetch.js:55-67`) und setzen `\Seen` nicht. **Offen:** ob der `source`-Zweig (`fetch.js:99-115`) ebenfalls PEEK nutzt, ist nicht bestätigt; vor T64 prüfen.
- Alle Lesezugriffe weiter mit `getMailboxLock(path, { readOnly: true })` (EXAMINE). Dass EXAMINE implizites `\Seen` verhindert, folgt aus RFC 3501/9051, nicht aus imapflow-Code.

## 2. `\Seen` setzen und entfernen

- `messageFlagsAdd(range, flags, options?)` und `messageFlagsRemove(range, flags, options?)` → `Promise<boolean>` (`imap-flow.d.ts:429, 443`); immer mit `{ uid: true }`.
- Gesendet wird `UID STORE … +FLAGS` / `-FLAGS` (`commands/store.js` ~120-135).
- **Fehler sind still:** Bei NO/BAD (z. B. schreibgeschützt geöffnetes Postfach) gibt die Methode `false` zurück und wirft nicht. Rückgabewert immer prüfen, `false` → Aktion `failed`.
- Vom Postfach nicht erlaubte Flags werden mit Warnung verworfen; bleibt nichts übrig → `false` (`store.js` ~40-80).
- Eine nicht mehr existierende UID ist in IMAP kein Fehler (Server antwortet OK, Rückgabe `true`). Wer Gewissheit braucht, liest die Flags danach neu.
- **UIDVALIDITY prüft imapflow nicht.** Der Aufrufer vergleicht den gespeicherten Wert (`email_locations.uid_validity`) mit dem aktuellen (`uidValidity`, `types.d.ts:221`; genauer Zugriff auf das Mailbox-Objekt in T57 verifizieren) und schreibt bei Abweichung nicht.
- `unchangedSince` wirkt nur mit aktivem CONDSTORE (`store.js:90`), sonst wird es ignoriert. Für idempotentes `\Seen` nicht nötig.

## 3. Verbindungen und Locks

- Locks stehen pro Verbindung in einer Warteschlange; ein readOnly- und ein schreibbarer Lock auf dieselbe Mailbox können nicht gleichzeitig bestehen. Ein Wechsel des Zugriffsmodus erzwingt ein neues SELECT/EXAMINE (`imap-flow.js:3659-3672`).
- IDLE wählt das Postfach nach Reconnects neu (`commands/idle.js:208, 230`); ein Schreib-Lock auf der Leseverbindung würde die IDLE-Sicht stören.
- **Entscheidung:** Schreiben über eine **eigene, kurzlebige Verbindung**. Die Lese-/IDLE-Verbindung bleibt unverändert und readOnly.

## 4. Muster für `ImapWritePort.addSeen` / `removeSeen`

1. Lesepfad (`packages/core/src/imap.ts`) unverändert: nur `readOnly: true`, keine Schreibmethoden.
2. Schreibport öffnet eine eigene ImapFlow-Verbindung, `getMailboxLock(folder, { readOnly: false })`.
3. UIDVALIDITY des Ordners mit dem gespeicherten Wert vergleichen; bei Abweichung ohne Schreiben abbrechen (`failure_code = uidvalidity_changed`).
4. `ok = await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true })` (bzw. `messageFlagsRemove`); `ok === false` → `failed`.
5. Optional Flags der UID neu lesen und bestätigen; Lock freigeben, Verbindung schließen. Nie `expunge`, `messageDelete`, `messageMove` (bis M7), `append`.

## 5. Unbekannt

- Provider-Besonderheiten von web.de/GMX bei Flags: keine Quelle gefunden. Im Trockenlauf (T59a) und beim ersten Live-Schritt beobachten, nichts annehmen.

## 6. Umsetzung (M7a, Phase 17)

Stand 2026-10-27. Alles gegen Fakes getestet; es gab keine Verbindung zu einem echten Mailserver.

- **Schreibport:** `packages/core/src/imap-write.ts` (`createImapWritePort`). Genau zwei Methoden, `addSeen(folder, uidValidity, uid)` und `removeSeen(...)`. Jeder Aufruf nutzt eine eigene, kurzlebige ImapFlow-Verbindung, `getMailboxLock(folder, { readOnly: false })`, vergleicht UIDVALIDITY des Ordners mit dem gespeicherten Wert (Abweichung: Fehlercode `uidvalidity_changed`, nichts wird geschrieben), sendet `messageFlagsAdd/Remove([uid], ['\\Seen'], { uid: true })` und liest die Flags der UID danach zurück (Abschnitt 2: ein Server-OK für eine verschwundene UID wäre sonst ein stiller Erfolg). Der Port löst bei jedem Fehler einen `ImapWriteError` mit genau einem Code aus: `imap_auth`, `imap_error`, `invalid_target`, `uidvalidity_changed`, `store_rejected` (imapflow lieferte `false`), `message_gone`, `store_unverified`. Weder Servertext noch Host, User, Passwort oder UID stehen in der Fehlermeldung (H4). Lock und Verbindung werden immer freigegeben.
- **Nicht vorhanden:** Löschen, Verschieben, Kopieren, Anhängen, EXPUNGE. Ein Test sucht den Quelltext danach und belegt, dass `packages/core/src/imap.ts` (Lesepfad) unverändert keine Schreibmethode und kein `readOnly: false` enthält. `moveTo` kommt erst mit M7 (H16a).
- **Wer den Port erzeugt:** nur `packages/core/src/mailbox-actions.ts` (Quelltext-Test über das ganze Repo). Routen und Worker benutzen den Executor, nie den Port.
- **Offen aus Abschnitt 1:** ob der `source`-Zweig von `fetch` `BODY.PEEK` nutzt, wurde nicht geprüft und ist für M7a unerheblich, weil der Lesepfad ohnehin in EXAMINE (`readOnly: true`) arbeitet und das Postfach nichts ändern darf. Vor dem ersten `live`-Schritt gegen ein echtes Postfach beobachten (Abschnitt 5).
- **Executor und Regel:** `packages/core/src/mailbox-rules.ts` (reine Funktion, Schutz zuerst, dann „Spam gelesen“) und `packages/core/src/mailbox-actions.ts` (Modus je Konto, Not-Aus, Tageslimit, Idempotenz, Undo). Siehe README, Abschnitt „Automatische Aktionen“.

## Not-Aus-Semantik (R3, ADR 0016, 0025, 0044)

Zwei Stufen, beide werden **vor jeder Aktion** gelesen (`packages/core/src/mailbox-actions.ts`):

1. **Global:** die Datei `auto-actions.disabled` neben der Datenbank. Solange sie existiert, wird nichts geplant und nichts geschrieben, auch kein Rückgängigmachen am Server. Die App zeigt sie allen Nutzern an (nur lesend); Admins können sie nach Bestätigung anlegen und entfernen. Die Datei bleibt der Not-Aus von außen (ohne App, ohne Datenbank).
2. **Pro Nutzer:** `user_settings.auto_actions_stopped_at`. Gleiche Wirkung für die Konten dieses Nutzers (Ergebnis `user_stop`; Undo am Server liefert `409 user_stop`). Das Zurückstellen auf „ungelesen“ im Trockenlauf (nur App-Status) bleibt möglich. Ein nicht lesbarer Zustand zählt als gestoppt.

Der Backfill beim Start bricht beim globalen Stop ab; beim Nutzer-Stop überspringt er nur dessen Mails. Das Tageslimit (200 Live-Aktionen je Konto in 24 Stunden) bleibt unverändert und wird in der App je Konto angezeigt. `live` setzt nur der Nutzer in der App nach Bestätigung (`confirm: true`), nie ein Agent und nie ein Standardwert.

## 7. Verschieben: Quarantäne und Papierkorb (R9, ADR 0025 Teil 2, ADR 0038)

Stand 2026-11-01, `imapflow` 2.9.1. Quellen: Context7 `/postalsys/imapflow` (`messageMove`, `mailboxCreate`, `list`, `CopyResponseObject`), installierte Quellen `node_modules/imapflow/dist/esm/commands/move.js`, `create.js`, `copyuid-parser.js`, `types.d.ts` (`ListResponse`, `NamespaceObject`). Kein Kontakt zu einem echten Mailserver; alles gegen einen Fake-Client getestet (`tests/imap-write-move.test.ts`).

**Befund, der die Umsetzung bestimmt.** `messageMove(range, destination, { uid: true })` sendet bei `MOVE` im Server-CAPABILITY ein `UID MOVE` (RFC 6851). **Fehlt `MOVE`, emuliert imapflow die Verschiebung selbst: `messageCopy`, dann `messageDelete` (also `\Deleted` und EXPUNGE) auf dem Quellordner** (`commands/move.js`). Die Dokumentation nennt das nur „equivalent to copy + delete“. Genau das ist durch ADR 0025 verboten. Der Port ruft `messageMove` deshalb **nur auf, nachdem `client.capabilities.has("MOVE")` gilt**; sonst `move_unsupported`, vor jedem LIST, CREATE, Lock oder Schreiben. Ein Quelltext-Test belegt: genau ein `messageMove(`, genau ein `mailboxCreate(`, die Fähigkeitsprüfung steht davor, und `messageDelete`, `messageCopy`, EXPUNGE, `\Deleted`, `append(` kommen im Modul nicht vor. Der Fake-Client im Test wirft bei jeder anderen Methode.

**Methode.** `moveMessage({ folder, uidValidity, uid, target, inboxFolder? })` → `{ folder, uidValidity?, uid? }`; `target` ist `quarantine`, `trash` oder `inbox`.

1. Eingaben prüfen (`invalid_target`, vor jeder Verbindung). Eigene, kurzlebige Verbindung (Abschnitt 3). Auth- und Verbindungsfehler: `imap_auth`, `imap_error`.
2. `MOVE`-Fähigkeit prüfen: sonst `move_unsupported`, Abbruch.
3. Zielordner bestimmen (`client.list()`):
   - `quarantine`: Pfad `Namensraum-Präfix + "Quarantäne"` (`client.namespace.prefix`); vorhanden: verwenden. Sonst `mailboxCreate("Quarantäne")`: imapflow ergänzt das Präfix, kodiert Umlaute als modifiziertes UTF-7 (`encodePath`), legt an und **abonniert** den Ordner; `ALREADYEXISTS` ist `created: false` und kein Fehler. Scheitert das Anlegen: `folder_create_failed`. **Nur dieser Zweig legt je einen Ordner an**, nur im Schreibpfad (`trash` und `inbox` nie).
   - `trash`: der Ordner mit Special-Use `\Trash` (die Erweiterung des Servers vor dem Namens-Hinweis von imapflow, `specialUseSource`), sonst ein Ordner mit einem Namen aus `Trash`, `Papierkorb`, `Deleted Items`, `Deleted Messages`, `Gelöschte Elemente`, `Gelöschte Objekte`, `Gelöschte Nachrichten` (ohne Groß-/Kleinschreibung). Nichts gefunden: `trash_not_found`; es wird kein Papierkorb angelegt und nichts gelöscht.
   - `inbox`: `inboxFolder` (der Ordner des Kontos).
   - Quelle gleich Ziel: `invalid_target`.
4. `getMailboxLock(folder, { readOnly: false })`, UIDVALIDITY mit dem gespeicherten Wert vergleichen (`uidvalidity_changed`), UID noch vorhanden (`message_gone`).
5. `messageMove([uid], ziel, { uid: true })`. `false` heißt, der Server hat abgelehnt: `move_rejected`.
6. Rücklesen: die UID im Quellordner muss weg sein, sonst `move_unverified`.
7. `COPYUID` (UIDPLUS; `uidValidity` und `uidMap` im Ergebnis): Zielordner schreibgeschützt öffnen (`readOnly: true`, EXAMINE), UIDVALIDITY gleich dem `COPYUID`-Wert und neue UID vorhanden, sonst `move_unverified`. Ergebnis: neuer Ort mit Ordner, UIDVALIDITY und UID. Ohne `COPYUID`: nur der Ordner; der Executor kann den neuen Ort nicht speichern (kein Aufräumen, kein Undo für diese Mail).

**Executor (`packages/core/src/mailbox-actions.ts`).** Reihenfolge je Mail: importiert (`origin = 'import'`) → nie; Modus des Kontos (`mail_accounts.quarantine_mode`, Standard `off`); globale Stop-Datei; Not-Aus des Nutzers; Schutz (`security_auth`, `transactional`, Positivliste) vor der Spam-Regel; Tageslimit; Move; Protokollzeile in `mailbox_actions` (`quarantine` / `move_quarantine`, `purge` / `move_trash`, Undo: `undo` / `move_inbox`); bei Erfolg neuer Ort in `email_locations` (alter inaktiv), Audit `folder_changed` und `mailbox_action` nur mit Codes. Ein Fehler wird als `failed` mit Code gespeichert und nicht wiederholt.

**Aufräumen.** Job im Server-Prozess (`server.ts`, alle 30 Minuten und einmal nach dem Start): `quarantine`-Zeilen (`done`, `live`) älter als `quarantine_days`, Mail noch in einem Ordner namens `Quarantäne` → `purge`. Dieselben Stopps, Limits und Schutzregeln; Trockenlauf plant nur.

**Undo.** `POST /api/actions/:id/undo`: geplant = Plan verwerfen; erledigt = `moveMessage({ target: 'inbox' })` vom aktuellen Ort, Status `undone` am Original (und an der Quarantäne-Zeile, wenn die Papierkorb-Aktion zurückgenommen wird). Gesperrt durch beide Not-Aus-Stufen (`409`).

**Offen (am echten Postfach beobachten, nichts annehmen).** Ob web.de/GMX/Gmail `MOVE` und `UIDPLUS` melden, wie ihr Papierkorb heißt (`\Trash` oder Fallback), ob ein neuer Ordner im Webmail sofort sichtbar ist, und wie sie ein Abonnieren handhaben. Der erste Live-Schritt gehört in den Trockenlauf vorweg und liegt bei Nico.
