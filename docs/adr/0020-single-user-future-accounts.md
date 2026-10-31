# 0020 Single-User jetzt; Konten in der UI / Multi-User später

- Status: ersetzt durch 0022 und 0023
- Datum: 2026-10-31
- Bezug: Frage von Nico 2026-10-31, 0003, 0004, 0011

## Kontext
Heute: ein Nutzer, Konten (inkl. IMAP-Passwörter) in einer JSON-Datei neben der DB, Login per Passwort oder Tailnet. Wunsch: echter Login und Konten in der UI pflegen.

## Entscheidung (vorgeschlagen)
Zwei getrennte Schritte:
1. **Single-User, Konten in der UI** (kleine Erweiterung): Tabelle für Konten-Konfiguration, IMAP-Zugangsdaten mit einem Schlüssel aus fly-Secrets verschlüsselt (AES-GCM), Formular im ⋯-Menü, Verbindungstest lesend. Rest der Architektur bleibt.
2. **Multi-User** (andere Architektur): `user_id` in allen Tabellen, Mandantentrennung in jeder Abfrage, Nutzerverwaltung, Worker pro Nutzer, eher Postgres, DSGVO-Pflichten für fremde Daten. Nur bei echtem Bedarf.

## Folgen
- Schritt 1 ist als eigener Meilenstein planbar, wartet auf Nicos Freigabe.
- Bis dahin bleibt die Konten-Datei verbindlich und wird nie gelesen/ausgegeben/committet.
