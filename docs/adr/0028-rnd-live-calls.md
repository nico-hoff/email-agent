# 0028 Live-Aufrufe für Forschung und Entwicklung

- Status: angenommen
- Datum: 2026-10-31
- Bezug: ändert 0019 („Live-Aufrufe nur Nico“), 0006, 0014

## Kontext
Kalibrierung v2, Themen-Choice (0026) und Agenten-Evals brauchen echte Jev-/Modell-Aufrufe. Nico: Dev darf denselben OpenRouter-Schlüssel wie Prod nutzen; der Schlüssel hat ein Ausgabenlimit.

## Entscheidung
Agenten dürfen für R&D live aufrufen (Jev-Proben, Evals, Agenten-Proben), **nur mit synthetischen Inhalten** (HF-Datensets, eigene Fixtures). Nie mit echten Mails, nie IMAP auf echte Postfächer, nie `live`-Schaltung von Aktionen. Kosten begrenzt das Limit des Schlüssels. Ergebnisse (Scores, Berichte) dürfen ins Repo, Roh-Responses nicht (0004).

## Folgen
- Der Schlüssel muss in der Agenten-Umgebung als Secret verfügbar sein (Claude-Cloud-Umgebung bzw. Dev-Rechner).
