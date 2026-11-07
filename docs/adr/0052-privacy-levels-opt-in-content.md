# 0052 Datenschutz-Stufen: Mailinhalte nur nach Opt-in speichern

- Status: Entwurf (nichts entschieden; ändert H3 erst nach Nicos Freigabe)
- Datum: 2026-11-07
- Bezug: Wunsch Nico 2026-11-07, `VISION.md`, H3 (keine Inhalte persistieren), 0050 (Threads/Workstreams), 0049 (Postgres auf Neon), 0045 (Envelope-Verschlüsselung)

## Kontext
Heute speichert die App nur Metadaten (Absender, Betreff, Zeitpunkte, Ordner) und Bewertungen. Mailtext wird nur zum Klassifizieren kurz gelesen und nie abgelegt (H3). Das ist ein starkes Datenschutzversprechen. Es begrenzt aber, was die App kann:
- **Keine Mail-Ansicht in der App:** Den Text gibt es nur im Postfach. Ein Abruf bei jedem Öffnen wäre langsam (IMAP-Verbindung, Login, Suche).
- **Keine Volltextsuche** über alle Konten.
- **Workstreams, To-dos und Deadlines** (0050) nur aus Metadaten und Jev-Antworten, nicht aus dem Text.

Nico hätte kein Problem damit, dass seine Mails auf dem Server liegen, wenn es Vorteile bringt. Das soll aber nur eine Option sein.

## Idee: wählbare Stufen je Nutzer
| Stufe | Was gespeichert wird | Standard |
|---|---|---|
| **Sparsam** (heute) | nur Metadaten und Bewertungen; Text nur flüchtig zum Klassifizieren | ja, für alle |
| **Komfort** (Opt-in) | zusätzlich der Mailtext (ohne Anhänge), verschlüsselt je Nutzer; ermöglicht Ansicht in der App, Volltextsuche, schnellere Ladezeiten und reichere Workstream-Analyse | nein, nur nach ausdrücklicher Zustimmung |

## Anforderungen, falls es kommt
- **Opt-in ist aktiv und einzeln:** eine eigene Zustimmung mit klarer Erklärung, kein Häkchen in den AGB. Jederzeit widerrufbar; ein Widerruf löscht alle gespeicherten Inhalte sofort und nachweisbar.
- **Verschlüsselung im Ruhezustand je Nutzer:** ein Datenschlüssel je Nutzer, verschlüsselt mit einem Hauptschlüssel (Envelope, 0045). Löschen heißt Schlüssel vernichten.
- **Inhalte nie in Logs, Fehlermeldungen, Telemetrie, Fixtures oder Evals** (H3/H4 gelten weiter). Evals bleiben synthetisch.
- **Aufbewahrung begrenzt** (z. B. 90 Tage oder wählbar). Export und Löschung umfassen die Inhalte (go2market-Gate).
- **Anhänge:** vorerst nicht speichern.
- **Volltextsuche:** Postgres-Volltext auf verschlüsselten Daten geht nicht direkt. Optionen sind ein Suchindex je Nutzer, Entschlüsselung im Speicher oder Verzicht auf die Suche. Das ist eine eigene Entscheidung.
- **Indizieren ohne Opt-in:** Metadaten sind schon in der Datenbank indiziert (Liste, Filter, Zählungen laufen ohne IMAP-Abruf). Für schnelle Listen braucht es keine Inhalte.

## Offene Fragen
1. Gibt es die Stufe „Komfort“, und ab wann (vor oder nach go2market)?
2. Ist Komfort ein Bezahlmerkmal oder für alle verfügbar?
3. Welche Funktionen setzen Komfort voraus, welche müssen auch in „Sparsam“ funktionieren? Vorschlag: Klassifikation, Sortierung und Workstreams aus Metadaten funktionieren immer.
4. Wie heißt H3 danach? Vorschlag: „Ohne Opt-in keine Inhalte; mit Opt-in nur verschlüsselt je Nutzer, nie in Logs/Telemetrie/Fixtures.“

## Folgen
Bis zur Entscheidung gilt H3 unverändert. Die Umsetzung bräuchte eine Schema-Migration, eine Schlüsselverwaltung je Nutzer und eine neue Datenschutzerklärung.
