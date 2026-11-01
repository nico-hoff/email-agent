# QA Erst-Import: neues Postfach live lesen und bewerten (ADR 0043)

Stand 2026-11-01, Branch `wt/sync`. Screenshots (Fake-Postfach und Fake-Jev, 390x844): `docs/qa/img/sync-*.png`. Vertrag: `docs/accounts-contract.md`, Entwurf: `docs/adr/0043-initial-import.md`.

## Was ist neu

- Ein neu hinzugefügtes Konto bleibt nicht mehr leer: der Server liest **einmal** die neuesten Mails des Posteingangs (höchstens 50, nur aus den letzten 14 Tagen) und lässt sie von System One bewerten. Das gilt auch für bestehende Konten, die den Import noch nie hatten (beim ersten Start mit dieser Version).
- **Live-Karte** in Profil → Konten, direkt nach „Konto speichern“: vier Stufen „Verbinde mit dem Postfach“ → „Lese Mails (37/50)“ → „System One klassifiziert (21/50)“ → „Fertig“, zwei Fortschrittsbalken und eine Liste der Mails, die gerade bewertet wurden (Betreff, Absender, Badges Spam / Kategorie / Wichtig / Offen). Die Karte fragt jede 1,5 s nach und hört nach „Fertig“ auf. Danach „Zu den Mails“ und „Import wiederholen“.
- **Nur lesen:** der Import nutzt denselben schreibgeschützten Lesepfad wie live (EXAMINE, SEARCH, FETCH). Der Inhalt wird nur im Speicher verarbeitet und nie gespeichert. Importierte Mails lösen **nie** eine automatische Postfach-Aktion aus (auch nicht, wenn „Spam gelesen“ auf live steht) und zählen **nicht** als „neu seit dem letzten Öffnen“. Absender-Statistik und Rückfragen (HITL) laufen normal.
- Bereich: nur Posteingang, nur Mails bis zur ersten bekannten Stelle (Checkpoint); neue Mails ab jetzt kommen wie bisher live. Beide Bereiche überlappen nie.
- Bei Abbruch (Netz weg, Neustart) macht der Import an der Stelle weiter; nichts wird doppelt angelegt. Abgelehnte Anmeldung: Karte „angehalten“ mit „Erneut versuchen“ (nach Passwortkorrektur unter „Bearbeiten“).
- Der Konten-Takt des Servers ist von 15 auf 5 Sekunden gesunken: ein neues Konto beginnt nach höchstens 5 Sekunden.

Screenshots: `sync-1-verbinden.png`, `sync-2-lesen.png`, `sync-3-klassifizieren.png`, `sync-4-klassifizieren-spaeter.png`, `sync-5-fertig.png` (hell), dunkel: `sync-*-dark.png`.

## Selbst ansehen ohne Postfach (kein Netz, kein Modell)

```sh
node scripts/sync-sim.ts --port 3410            # eigener Port, eigene DB data/sync-sim.sqlite
# http://127.0.0.1:3410, Anmeldung qa@synthetic.invalid / qqqqqq, Profil → Konto hinzufügen
# (beliebige Adresse und Passwort, Server imap.example.test); langsamer: --connect-ms 9000 --fetch-ms 450 --jev-ms 1600
```

Das ist der echte Server mit echtem Worker und echter Pipeline, nur mit einem Fake-Postfach (60 synthetische Mails, die ältesten 8 „zu alt“) und einem Fake-Jev. Die Datei läuft nicht auf fly und nicht mit `NODE_ENV=production`.

## iPhone-Checkliste für Staging mit deinem echten Konto (machst du selbst)

Vorher: Staging läuft (`npm run staging`, `docs/LOCAL_DEV_MAC.md` §2b), `ACCOUNTS_ENCRYPTION_KEY` in `.env.local`, du bist am iPhone angemeldet. Beachte: der Import schickt Betreffs und Auszüge **deines echten Postfachs** (bis zu 50 Mails) an System One über OpenRouter (Staging-Schlüssel, Limit gesetzt).

1. Profil → Konten → „Konto hinzufügen“: E-Mail, IMAP-Passwort (Gmail: App-Passwort), Server → „Konto speichern“.
2. Unter dem neuen Konto erscheint sofort die Karte „Erst-Import“, Stufe 1 „Verbinde mit dem Postfach“ mit wanderndem Balken (nach höchstens 5 s startet der Server das Konto).
3. Stufe 2 läuft: „Lese Mails (n/50)“ zählt hoch, der Balken füllt sich; schon währenddessen beginnt Stufe 3.
4. Stufe 3: „System One klassifiziert (n/50)“, darunter rutschen die bewerteten Mails von oben herein, mit Badges (Spam, Kategorie, „Wichtig: …“, „Offen“). Nichts ruckelt; Betreff und Absender werden bei Länge mit „…“ gekürzt.
5. Du kannst die Seite verlassen und zurückkommen: die Karte macht dort weiter, wo der Server ist. Bildschirm sperren und wieder öffnen: ebenfalls.
6. Nach „Fertig“ (grün): „Zu den Mails“ öffnet die Liste. Die importierten Mails stehen in Wichtig / Offen / Aussortiert wie alle anderen. Das Briefing meldet sie **nicht** als „neu seit dem letzten Öffnen“.
7. Im Postfach selbst (Mail-App oder Webmail) hat sich **nichts** geändert: keine Mail als gelesen markiert, nichts verschoben. Das gilt auch, wenn „Spam gelesen“ für das Konto später auf live steht: Importiertes bleibt unangetastet.
8. „Import wiederholen“ (nach „Fertig“): läuft schnell durch, weil alles bekannt ist; holt nur neue Mails dieses Bereichs, falls welche fehlen. Mehrfaches schnelles Drücken wird gebremst („Zu viele Neustarts“).
9. Fehlerfall: falsches Passwort eintragen und speichern: Karte „Erst-Import angehalten“ mit Hinweis auf die abgelehnte Anmeldung. Passwort unter „Bearbeiten“ korrigieren, dann „Erneut versuchen“.
10. Dunkelmodus und „Bewegung reduzieren“ (Einstellungen → Bedienungshilfen → Bewegung): die Karte bleibt lesbar; bei reduzierter Bewegung ohne Gleiten und Pulsieren.
11. Server neu starten, während „System One klassifiziert“ läuft: nach dem Start läuft der Import weiter und endet mit „Fertig“.

## Tests

`tests/initial-import.test.ts` (Bereichsrechnung: nur UIDs ≤ Checkpoint, N = 50 / Obergrenze 200 / mindestens 1, 14-Tage-Fenster ab 00:00 UTC; Worker mit Fake-Port und Fake-Klassifikation: Reihenfolge Baseline → Import, Zähler und Phasen, genau einmal, Konto aus der Zeit vor dem Feature, Abbruch und Wiederaufnahme ohne Duplikate, Neustart des Prozesses, Wiederholung nur aus `done`/`failed`, abgelehnte Anmeldung, Import ohne Klassifikator, fehlgeschlagene Bewertung; Inhalt nie in der DB; keine Postfach-Aktion in keinem Modus; nicht „neu seit dem letzten Öffnen“; Feed höchstens 10), `tests/accounts-api.test.ts` und `tests/tenant-isolation.test.ts` (Sync-Routen, fremde ID 404, Neustart fremder Konten ändert nichts, Rate-Limit), `tests/sync-card-render.test.ts` (Karte in allen Stufen, Badges, Fehler, Client), `tests/db.test.ts` (Migration 008, DDL = erd.md), `npm run smoke:e2e`, `npm run smoke:docker` (Migrationen 1 bis 8).

## Bekannte Grenzen

- `SEARCH SINCE` arbeitet tagesgenau mit dem Empfangsdatum des Servers: das Fenster reicht faktisch bis zu 15 Tage zurück (ab 00:00 UTC des 14. Tages davor). Weniger als 50 Mails im Fenster: nur diese.
- Nur der Posteingang. Der Spam-Ordner wird nicht importiert (Spam, den der Anbieter schon aussortiert hat, taucht nicht auf).
- Steht System One still (Fehler, leeres Guthaben), bleibt die Karte bei „System One klassifiziert“; nach 30 Minuten endet der Import mit Hinweis, die Pipeline bewertet im Hintergrund weiter.
- Nach einem Absturz im Moment zwischen Lesen und Bewertung werden betroffene Mails beim nächsten Workerstart erneut gelesen (nicht sofort).
- Die Fortschrittszahl „bewertet“ aktualisiert der Server alle 2 Sekunden, die Karte fragt alle 1,5 Sekunden: Sprünge um 1 bis 2 sind normal.
- Mails mit fehlgeschlagener Bewertung zählen als „nicht bewertbar“ und erscheinen mit dem Badge „Bewertung fehlgeschlagen“ in der Liste; „Import wiederholen“ bewertet sie nicht erneut (das ist Sache der Pipeline-Wiederholung).
- Die Simulation (`scripts/sync-sim.ts`) ist ein QA-Werkzeug, kein Produktpfad.
