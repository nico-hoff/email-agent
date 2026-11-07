# 0049 Datenplattform: Supabase (selbst gehostet oder Cloud) oder reines Postgres

- Status: vorgeschlagen (Entscheidung Nico offen)
- Datum: 2026-11-07
- Bezug: Frage Nico 2026-11-07 („Supabase als Backend-as-a-Service, selbst gehostet?“), 0045 (Postgres + RLS ab ~200 Nutzern), 0048 (Monorepo), 0022/0033 (eigene Nutzerkonten, Mandant = Nutzer), H1 (keine Mailinhalte speichern)

## Kontext
Mit dem Ziel aus 0048 (100–2.000 zahlende Nutzer) wird Postgres mit Row-Level-Security (RLS) zur Grundlage. Offen ist, ob Supabase diese Grundlage liefert und in welcher Form.

Supabase-Doku über Context7 (`/websites/supabase_guides`, 2026-11-07):
- **Selbst gehostet** läuft Supabase per Docker Compose mit vielen Diensten: Postgres, Auth (GoTrue), PostgREST, Realtime, Storage, Edge Functions, postgres-meta, Studio, Pooler und Analytics, davor ein API-Gateway (Envoy).
- **Mindestens** 4 GB RAM, 2 Kerne, 40 GB SSD; empfohlen 8 GB+ und 4 Kerne+.
- **Nur ein Projekt**, konfiguriert über Umgebungsvariablen.
- **Fehlt beim Selbsthosten:** Branching, Metriken über Logs hinaus, verwaltete Backups und PITR, Analytics- und Vector-Buckets, ETL, Management-API.
- **Weitere Bausteine:** Queues (`pgmq`), Auth-Hooks (Custom Access Token Hook für eigene JWT-Claims), Session-Pooler für Server-Verbindungen.

Was diese App von einer Datenplattform braucht:
- Postgres mit RLS als zweite Mandantengrenze.
- Dauerhafte Server-Verbindungen für die IMAP-Worker, eine Queue zwischen Lesen und Klassifizieren, Backups und Wiederherstellung.
- Daten in der EU.

Was sie nicht braucht:
- Dateispeicher. Nach H1 werden keine Inhalte und keine Anhänge gespeichert.
- Edge Functions. IMAP-IDLE braucht dauerhafte Node-Prozesse.
- Direkten Datenbankzugriff aus dem Browser. Die Sicherheitslogik (Schreibport, Gates, Datenschutzregeln) liegt bewusst im Server und ist dort getestet.

## Optionen

| | A: Supabase selbst gehostet | B: Supabase Cloud (EU) | C: reines Postgres, verwaltet (Neon, fly Managed Postgres o. ä.) |
|---|---|---|---|
| Betrieb | ein Dutzend Container, Upgrades, Backups (WAL-Archiv), Gateway und Studio absichern: alles selbst | verwaltet | verwaltet |
| Backups, PITR, Branching | **nicht enthalten**, selbst bauen | enthalten (je nach Plan) | enthalten (Neon: Branching, PITR) |
| Ressourcen und Kosten | ≥ 4 GB RAM / 2 Kerne nur für die Plattform (heute läuft die ganze App auf 512 MB) | Plan-Gebühr, vor Entscheidung auf supabase.com/pricing prüfen | nutzungsabhängig; Neon 0,25 CU dauerhaft ≈ 19 $/Monat (Rechnung vom 2026-11-04) |
| Auth | GoTrue: E-Mail, Magic Link, OAuth, MFA, Hooks | wie A, verwaltet | eigene Nutzerkonten wie heute (oder später eine Bibliothek) |
| RLS-Modell | `auth.uid()` aus dem JWT, auf Browser-Direktzugriff ausgelegt | wie A | `set_config('app.user_id', …)` pro Transaktion aus dem Server |
| Extras | Realtime, `pgmq`, `pg_cron`, `pgvector`, Studio | wie A | Extensions je Anbieter (`pgvector` meist vorhanden; Queue über pg-boss) |
| Datenhoheit | eigene Infrastruktur | EU-Region, AV-Vertrag nötig | EU-Region, AV-Vertrag nötig |
| Lock-in | gering (Postgres), Auth-Schema Supabase-spezifisch | wie A | sehr gering |

## Bewertung
- **A (selbst gehostet) ist für dieses Projekt die teuerste Variante.**
  - Den vollen Betriebsaufwand trägt eine Person.
  - Es fehlt genau das, was eine verwaltete Plattform wertvoll macht: Backups, PITR, Branching.
  - Die Mindestressourcen übersteigen die ganze heutige App um ein Vielfaches.
  - Selbsthosten lohnt sich bei strengen Vorgaben zur Datenhoheit oder bei großer Last mit eigenem Betriebsteam. Beides trifft hier nicht zu.
- **B (Supabase Cloud) lohnt sich, wenn Supabase Auth die eigenen Nutzerkonten ersetzen soll.**
  - Das brächte Magic Links, OAuth und MFA ohne Eigenbau, dazu Studio und Branching.
  - Dafür müssten die Nutzerkonten (R1) migriert werden. Die Passwort-Hashes sind nicht kompatibel, Nutzer müssten ein neues Passwort setzen. Das ist heute billig (ein Nutzer) und später teuer.
  - Das Browser-Direktzugriffsmodell (PostgREST) würde nicht genutzt. Supabase wäre im Kern verwaltetes Postgres plus Auth.
- **C (reines Postgres) passt am besten zum heutigen Server-Modell.**
  - Die API und die Worker sprechen Postgres direkt an, mit RLS über `set_config` und einer App-Rolle ohne `BYPASSRLS`, Kysely als Query-Builder (0045) und pg-boss als Queue.
  - Am wenigsten Neues, kein Auth-Umbau.
  - Fehlt etwas, etwa Magic Links, kommt es als Bibliothek dazu, nicht als Plattform.

## Vorschlag
- **Nicht selbst hosten (A).**
- **C als Standard**, mit dem RLS-Schema so angelegt, dass ein späterer Umzug zu B möglich bleibt:
  - Mandanten-Funktion `app.current_user_id()` statt verstreuter `current_setting`-Aufrufe.
  - UUIDs für neue Nutzer-IDs.
  - Keine Abhängigkeit von anbieterspezifischen Extensions außer `pgvector`.
- **B nur wählen, wenn Nico die eigenen Nutzerkonten zugunsten von Supabase Auth aufgeben will.** Dann vor dem ersten externen Nutzer migrieren, nicht danach.

## Offene Entscheidung (Nico)
1. Eigene Nutzerkonten behalten (→ C) oder Supabase Auth (→ B)?
2. Anbieter für C: Neon (Branching für Previews) oder fly Managed Postgres (gleiche Plattform wie die App). Preise und EU-Region vor der Wahl prüfen.
3. Zeitpunkt: Postgres vor R5 (erster Prod-Deploy, dann keine SQLite-Daten in Prod zu migrieren) oder danach mit Datenübernahme.

## Folgen
- Nach Nicos Entscheidung wird diese ADR angenommen oder durch eine neue ersetzt. Die Umsetzung (Postgres-Migration, Kysely, RLS, Queue) bekommt eigene ADRs und einen Meilenstein in `docs/ROADMAP.md`.
- **Unabhängig von der Wahl:** Kein Dateispeicher und keine Embeddings von Mailinhalten (H1). `pgvector` nur für Daten, die gespeichert werden dürfen, etwa das Nutzer-Gedächtnis aus R12.
