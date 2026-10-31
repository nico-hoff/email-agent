# 0026 Themen als Jev-Choice: Alltagsthemen plus eigene Liste

- Status: angenommen (Live-Probe offen)
- Datum: 2026-10-31
- Bezug: Plan v5 M4, 0006, 0007, `docs/jev-contract.md`

## Kontext
Mails sollen in App-Ordner nach Thema. Feste Ordner passen nicht für jeden; eigene Themen sollen möglich sein.

## Entscheidung
- Neues Fragenset (v3) mit einer Choice-Frage `topic`: feste Alltagsthemen (z. B. Finanzen, Einkäufe/Bestellungen, Reisen, Arbeit, Behörden/Verträge, Gesundheit, Familie/Freunde, Wohnen, Bildung, Vereine/Hobbys, Newsletter, Sonstiges) **plus** die eigenen Themen des Nutzers (Profil → Themen).
- Die Optionsliste wird pro Nutzer gebaut und mit Version gespeichert; Änderung der eigenen Liste ⇒ neue Listenversion.
- Vor der Einführung prüft eine Live-Probe mit synthetischen Mails, wie viele Optionen Jev zuverlässig unterscheidet; ggf. zwei Stufen (Grobthema, dann eigenes Thema).

## Folgen
- Kalibrierung und Eval für `topic` wie in 0007/0014; ohne Probe bleibt das Feature hinter einem Schalter.
