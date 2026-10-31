# 0015 UI: React ohne UI-Framework, PWA, SW cacht nur die Shell

- Status: angenommen
- Datum: 2026-10-29
- Bezug: `app/`, `components/`, `public/` (Manifest, Service Worker)

## Kontext
Hauptgerät ist das iPhone. Ein Postfach für alle Konten, Konto nur als Tag, sortiert nach Dringlichkeit, „Signal statt Rauschen“.

## Entscheidung
Veryfront-Seiten mit React und eigenem CSS (hell/dunkel), kein Komponenten-Framework. Installierbar als PWA. Der Service Worker cacht nur die App-Shell, **nie** API-Antworten (keine Mail-Metadaten im Gerätecache). Seiten: Welcome, Start (Wichtig/Offen/Alle), Detail, Aussortiert, Absender.

## Folgen
- Offline zeigt die App nur die Shell.
- Nur ein Agent arbeitet gleichzeitig an der UI (Konflikte in CSS/Komponenten).
