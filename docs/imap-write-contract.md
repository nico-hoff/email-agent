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

1. Lesepfad (`lib/imap.ts`) unverändert: nur `readOnly: true`, keine Schreibmethoden.
2. Schreibport öffnet eine eigene ImapFlow-Verbindung, `getMailboxLock(folder, { readOnly: false })`.
3. UIDVALIDITY des Ordners mit dem gespeicherten Wert vergleichen; bei Abweichung ohne Schreiben abbrechen (`failure_code = uidvalidity_changed`).
4. `ok = await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true })` (bzw. `messageFlagsRemove`); `ok === false` → `failed`.
5. Optional Flags der UID neu lesen und bestätigen; Lock freigeben, Verbindung schließen. Nie `expunge`, `messageDelete`, `messageMove` (bis M7), `append`.

## 5. Unbekannt

- Provider-Besonderheiten von web.de/GMX bei Flags: keine Quelle gefunden. Im Trockenlauf (T59a) und beim ersten Live-Schritt beobachten, nichts annehmen.

## 6. Umsetzung (M7a, Phase 17)

Stand 2026-10-27. Alles gegen Fakes getestet; es gab keine Verbindung zu einem echten Mailserver.

- **Schreibport:** `lib/imap-write.ts` (`createImapWritePort`). Genau zwei Methoden, `addSeen(folder, uidValidity, uid)` und `removeSeen(...)`. Jeder Aufruf nutzt eine eigene, kurzlebige ImapFlow-Verbindung, `getMailboxLock(folder, { readOnly: false })`, vergleicht UIDVALIDITY des Ordners mit dem gespeicherten Wert (Abweichung: Fehlercode `uidvalidity_changed`, nichts wird geschrieben), sendet `messageFlagsAdd/Remove([uid], ['\\Seen'], { uid: true })` und liest die Flags der UID danach zurück (Abschnitt 2: ein Server-OK für eine verschwundene UID wäre sonst ein stiller Erfolg). Der Port löst bei jedem Fehler einen `ImapWriteError` mit genau einem Code aus: `imap_auth`, `imap_error`, `invalid_target`, `uidvalidity_changed`, `store_rejected` (imapflow lieferte `false`), `message_gone`, `store_unverified`. Weder Servertext noch Host, User, Passwort oder UID stehen in der Fehlermeldung (H4). Lock und Verbindung werden immer freigegeben.
- **Nicht vorhanden:** Löschen, Verschieben, Kopieren, Anhängen, EXPUNGE. Ein Test sucht den Quelltext danach und belegt, dass `lib/imap.ts` (Lesepfad) unverändert keine Schreibmethode und kein `readOnly: false` enthält. `moveTo` kommt erst mit M7 (H16a).
- **Wer den Port erzeugt:** nur `lib/mailbox-actions.ts` (Quelltext-Test über das ganze Repo). Routen und Worker benutzen den Executor, nie den Port.
- **Offen aus Abschnitt 1:** ob der `source`-Zweig von `fetch` `BODY.PEEK` nutzt, wurde nicht geprüft und ist für M7a unerheblich, weil der Lesepfad ohnehin in EXAMINE (`readOnly: true`) arbeitet und das Postfach nichts ändern darf. Vor dem ersten `live`-Schritt gegen ein echtes Postfach beobachten (Abschnitt 5).
- **Executor und Regel:** `lib/mailbox-rules.ts` (reine Funktion, Schutz zuerst, dann „Spam gelesen“) und `lib/mailbox-actions.ts` (Modus je Konto, Not-Aus, Tageslimit, Idempotenz, Undo). Siehe README, Abschnitt „Automatische Aktionen“.
