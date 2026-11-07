# 0050 Threads und Workstreams: Mails als Artefakte eines Vorgangs

- Status: Entwurf (nichts entschieden, nichts gebaut)
- Datum: 2026-11-07
- Bezug: `VISION.md` (Pitch Nico 2026-11-07), 0008 (Jev-Fragen), R8 Themen (Fragenset v3 mit `topic`), R11 Follow-ups (0030), R12 Gedächtnis (0031), H3 (keine Inhalte persistieren)

## Kontext
Heute ist die Mail die Einheit. Gespeichert werden je Mail `message_id`, `sender`, `subject`, Zeitpunkte, Ordnerverlauf und Jev-Bewertungen einschließlich Thema. Nicht gespeichert werden Empfänger, CC und Thread-Header.

Nico möchte eine Ebene höher: Threads (eine Unterhaltung, auch über abgeschnittene Verläufe hinweg) und Workstreams (ein Vorgang über mehrere Threads, Personen und Postfächer). Darauf aufbauend: To-dos, Deadlines und Dringlichkeit je Workstream.

## Ideen für den Aufbau (zur Diskussion)
1. **Threads aus Headern**, deterministisch und ohne KI: `Message-ID`, `In-Reply-To`, `References`. Als Ersatz dienen normalisierter Betreff (ohne `Re:`/`AW:`/`Fwd:`), Teilnehmermenge und Zeitfenster. Neue Spalten: Empfänger, CC und die Thread-Header als Metadaten, kein Inhalt.
2. **Workstreams als Cluster von Threads:** Merkmale sind Teilnehmer (Personen, Domains), Jev-Thema, Betreffbegriffe und Zeit. Zuerst Regeln und Ähnlichkeit, ein LLM erst zur Benennung und für Grenzfälle. Der Nutzer kann Workstreams zusammenführen, trennen und benennen; das ist zugleich Trainingssignal.
3. **Zustand je Workstream:** offen/erledigt, nächste Deadline, offene To-dos, Dringlichkeit. Quelle sind Jev-Fragen je Mail (z. B. „enthält Frist“, „braucht Handlung“), eine generative Analyse nur auf Wunsch.
4. **Context Map für Agenten:** Ein Workstream liefert den Kontext für Zusammenfassung, Briefing und Follow-ups statt der einzelnen Mail.

## Offene Fragen
- **H3:** Sind Workstream-Namen, To-do-Texte und Deadlines „abgeleitete Inhalte“? Vorschlag: kurze, vom Nutzer sichtbare und löschbare Ableitungen (Name, To-do-Titel, Datum) sind erlaubt, Auszüge und Zusammenfassungen von Mailtext nicht. Das braucht eine ausdrückliche Regeländerung durch Nico.
- **Personenbezug:** Empfänger und CC sind personenbezogene Metadaten Dritter. Löschung und Export müssen sie umfassen (go2market-Gate).
- Reichen deterministische Threads plus Jev-Thema für brauchbare Workstreams, oder braucht es Embeddings? Embeddings von Mailtext wären gespeicherter Inhalt, also nein. Embeddings von Betreff und Metadaten sind möglich.
- Reihenfolge zu R11/R12: Follow-ups und Gedächtnis würden auf Workstreams aufsetzen.

## Nächster Schritt
Eine Probe mit synthetischen Verläufen: Wie gut finden Header-Threads plus Betreff-Heuristik die Verläufe? Danach die Entscheidung und eine eigene Schema-Migration.
