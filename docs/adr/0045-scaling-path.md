# 0045 Skalierungspfad: Schwellen, Web-Framework, Datenzugriff

- Status: vorgeschlagen (nichts davon wird jetzt gebaut)
- Datum: 2026-11-01
- Bezug: Fragen Nico 2026-11-01 („Wenn wir 10.000 User hätten?“, „Haben wir ein ORM/MVC?“, „Warum nicht Next.js?“), 0001, 0003, 0022, 0023, 0029, 0041, go2market-Gate in `docs/ROADMAP.md`

## Kontext
Die App ist für Nico und wenige Eingeladene gebaut: ein Node-Prozess mit Web, IMAP-Workern und Agenten (0001), eine SQLite-Datei (0003), rohes SQL in `lib/`, Veryfront als Framework (0029). Das trägt grob 10–50 Nutzer. Bei 10 000 Nutzern (≈ 20 000 Postfächer, ≈ 1 Mio. Klassifikationen pro Tag) brechen nacheinander: dauerhafte IMAP-Verbindungen (300–1 000 pro Maschine realistisch, Anbieter drosseln je IP), Google-Zugang (App-Passwörter für Fremdnutzer unzulässig, OAuth mit Gmail-Scope braucht Verifizierung und jährliches Sicherheits-Assessment), eine einzige Maschine als Ausfallpunkt, ein gemeinsamer Verschlüsselungsschlüssel, Rate-Limits im Prozessspeicher. Kosten der Klassifikation bleiben tragbar (Jev ≈ 0,06 USD je 1 000 Mails, `docs/insights-models.md`), brauchen aber ein Preismodell (0041).

## Vorschlag: Schritte nach Schwellen
| Schwelle (aktive Nutzer) | Schritt | Auslöser, an dem man es merkt |
|---|---|---|
| ~50 | IMAP-Worker als eigener Prozess bzw. eigene Maschine, Web getrennt; Rate-Limits in die DB | Speicher/CPU der einen Maschine, Neustarts unterbrechen IDLE |
| ~200 | Postgres statt SQLite (mit Row-Level-Security als zweite Mandantengrenze), Warteschlange zwischen Lesen und Klassifizieren (Tabelle + Worker oder pg-basierte Queue) | Schreibkonflikte, Backup/Restore einer großen Datei, zweite Maschine nötig |
| ~1 000 | Gmail `watch` (Pub/Sub) und Microsoft-Graph-Webhooks statt IDLE; Google/Microsoft OAuth statt App-Passwort; Konten auf mehrere Worker-Maschinen verteilt | Verbindungslimits der Anbieter, Verifizierungspflicht |
| ~10 000 | Schlüsselverwaltung über KMS mit Datenschlüssel je Nutzer (Envelope), Monitoring/Alarme, Budgets und Limits je Nutzer bei OpenRouter, Support-Prozesse | Risiko eines Schlüssel-Lecks, Betriebslast |

Vorbedingung für jede offene Registrierung bleibt das go2market-Gate (DSGVO, AGB, AV-Verträge, Lösch-/Exportfunktion).

## Web-Framework: Veryfront oder Next.js
- **Heute:** Veryfront bleibt (0029). Nur ≈ 50 Zeilen hängen direkt an der Veryfront-API, ≈ 7 000 von 8 000 Zeilen in `lib/` sind frameworkfrei; Seiten und Komponenten sind normales React.
- **Für Next.js spricht:** großes Ökosystem und Doku, reife Auth- und Middleware-Bausteine, weniger Eigenheiten (erlebt: Root-`middleware.ts` bricht den read-only-Container, CSS-Scanner und Worktrees, CSRF-Cookie hinter Proxys nur mit `VERYFRONT_TRUST_FORWARDED_HEADERS`, häufige 0.1.x-Patches), Vercel AI SDK für die Agenten-Schicht (in 0029 schon als Favorit genannt).
- **Gegen einen Wechsel jetzt:** kein funktionaler Gewinn für Nico; dauerhafte IMAP-Worker passen nicht ins Serverless-Modell von Next.js und bräuchten ohnehin einen eigenen Prozess; eingebaute Evals (`npm run eval`) müssten ersetzt werden.
- **Vorschlag:** Die Frage fällt zusammen mit dem Schritt „Worker vom Web trennen“ (~50 Nutzer). Dann Next.js (eigener Node-Server, kein Serverless für den Worker) für die Web-Seite prüfen; der Worker wird ein eigener Node-Dienst mit den Modulen aus `lib/`. Aufwand geschätzt: wenige Tage Agentenarbeit für Seiten, Routen-Hüllen, Auth-Guard/CSRF und Agenten-Hüllen.

## Datenzugriff: rohes SQL, Query-Builder oder ORM
- **Heute:** vorbereitete SQL-Statements in den Fachmodulen, Ergebnis-Typen per Cast; Mandantentrennung explizit über `accounts.user_id` in jeder Abfrage (0033), abgesichert durch Tests.
- **Schwäche:** Typen kommen nicht aus dem Schema, und jede neue Abfrage muss den Nutzerfilter selbst richtig setzen.
- **Volles ORM (Prisma, TypeORM):** abgelehnt; viel Gewicht, schwächere Kontrolle über SQLite-CHECKs und Trigger, Migrations- und ERD-Test müssten umgebaut werden.
- **Typisierter Query-Builder (Kysely, Drizzle):** sinnvoller Mittelweg; Typen aus dem Schema, ein zentraler `forUser(userId)`-Scope, der den Nutzerfilter erzwingt; erleichtert den späteren Wechsel zu Postgres. Unterstützung für `node:sqlite` vor der Wahl prüfen (Context7, Dialekt-Pakete).
- **Ohne neue Abhängigkeit:** SQL je Tabelle in `lib/repo/*.ts` bündeln, Zeilen mit zod prüfen, Nutzerabfragen nur über einen Scope-Helper zulassen.
- **Vorschlag:** Bis ~200 Nutzer die Variante ohne Abhängigkeit, sobald eine größere Datenarbeit ansteht (z. B. R11/R12); beim Postgres-Schritt Kysely oder Drizzle einführen.

## Folgen
- Kein Umbau jetzt; die Tabelle oben ist die Checkliste, wann welcher Schritt fällig ist.
- Neue Funktionen bleiben framework- und datenbankneutral in `lib/` (0029), damit die Schritte billig bleiben.
- Jeder Schritt bekommt bei Umsetzung eine eigene ADR, die diese ersetzt oder ergänzt.
