# Vision

> Entwurf aus Nicos Pitch vom 2026-11-07, offen für Diskussion. Technische Entscheidungen stehen in `docs/adr/`, der Fahrplan in `docs/ROADMAP.md`.

## Problem: E-Mail-Hygiene
Menschen haben mehrere Postfächer und Hunderte bis Tausende ungelesene Mails. Nico hat 4 Konten und rund 300 ungelesene Mails, ein Freund rund 1.000. Die Sortierung der Anbieter (Spam / nicht Spam / „Unbekannt“) taugt nicht dafür, zu erkennen, was wirklich zählt. Das Ergebnis ist Lärm: Wichtiges geht unter, Unwichtiges bleibt ungelesen liegen.

## Idee: ein Aggregator, der dein Mail-Leben ordnet
1. **Alles an einem Ort.** Alle Postfächer eines Nutzers werden zusammengeführt (heute IMAP, später Gmail/Outlook per OAuth).
2. **Klassifikation ist der Kern.** System One (Jev) bewertet jede Mail schnell und billig: Spam, Werbung, wichtig, dringend, braucht Antwort, Thema. Die Sortierung folgt den Wünschen des Nutzers, nicht den Regeln des Anbieters. Aufräumen (gelesen, Quarantäne, Papierkorb) geschieht nur, wenn der Nutzer es einschaltet.
3. **Eine Ebene höher: Threads und Workstreams.** Mails sind nur Artefakte, die entlang eines Vorgangs laufen. Die App erkennt Zusammenhänge über abgeschnittene Verläufe hinweg: Absender, Empfänger, Gruppen und CC, Betreffe, Zeit, Thema. Daraus entstehen Threads und Workstreams, etwa „Wohnungssuche“, „Steuer 2026“ oder „Hochzeit von X“.
4. **Daraus folgt Orientierung.** Je Workstream zeigt die App, was ansteht, was dringend ist, wo Deadlines liegen und welche To-dos offen sind. Erst hier lohnt generative KI: Sie analysiert den Kontext eines Workstreams (Context Engineering, Context Map) statt einzelne Mails zusammenzufassen.

Priorität: Aggregieren und Klassifizieren sind das Produkt. Workstreams sind der Unterschied zu anderen Apps. Generative Funktionen wie Zusammenfassungen und Entwürfe sind Zusatz.

## Für wen
- Privatleute (Consumer), nicht Unternehmen. Kein Corporate-Vertrieb, keine Organisationen als Mandant.
- Wer mehrere Postfächer hat und den Überblick verloren hat.

## Geschäftsmodell
- Side-Hustle aus einem echten eigenen Problem, nicht Startup um jeden Preis.
- Günstiges Abo, Größenordnung 1,99 € pro Monat für alles. Ziel ist ein vierstelliger monatlicher Umsatz, bei diesem Preis also rund 500–5.000 zahlende Nutzer.
- Klassifikation kostet laut Messung rund 0,06 $ je 1.000 Mails und trägt sich bei diesem Preis. Generative Funktionen brauchen Budgets je Nutzer (ADR 0041/0045).

## Grundsätze
- **Datenschutz als Produktmerkmal, wählbar:** Standard ist „sparsam“, also nur Metadaten und Bewertungen, keine Mailinhalte (H3). Wer will, kann per Opt-in „Komfort“ wählen: Mailtext verschlüsselt auf dem Server, dafür Ansicht in der App, Suche, schnellere Ladezeiten und bessere Workstreams (Entwurf ADR 0052). Nie senden. Schreiben ins Postfach nur, wenn der Nutzer es einschaltet.
- **Langweilig skalieren:** mandantenfähig von Anfang an (Postgres + RLS auf Neon, ADR 0049), Monorepo mit Frontend, Backend, Worker und Datenbank (ADR 0048). Leicht überdimensioniert für heute, damit Wachstum keine Umbauten erzwingt.
- **Holistischer Fullstack:** Product Engineering (Jev, Workstreams, KI), Service Reliability Engineering und Infrastruktur gehören gleichwertig zum Produkt. Das Projekt ist für Nico auch Lernfeld für Monorepo, Frontend, Backend und Datenbank.

## Offene Fragen
- Wie viel abgeleitetes Wissen (Workstream-Namen, To-dos, Deadlines) darf gespeichert werden, ohne H3 zu verletzen? Siehe ADR 0050.
- Welche Header werden zusätzlich gebraucht (Empfänger, CC, `In-Reply-To`, `References`)? Siehe ADR 0050.
- Wo leben die Agenten künftig (Veryfront im Backend oder ein anderes SDK)? Siehe ADR 0051.
- Datenschutz-Stufe „Komfort“ (Opt-in zum Speichern von Mailtext): ob, ab wann, ob Bezahlmerkmal? Siehe ADR 0052.
- Preis, Testphase, Free-Tier: go2market-Gate in `docs/ROADMAP.md`.
