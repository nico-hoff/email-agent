# 0027 Web-Push für die PWA statt nativer App

- Status: angenommen
- Datum: 2026-10-31
- Bezug: 0015, Frage „Apple-App?“ 2026-10-31

## Kontext
Die PWA hat keine Benachrichtigungen. Eine native App (SwiftUI/Capacitor) bräuchte Token-Login, APNs, Developer-Account. iOS unterstützt Web-Push für installierte PWAs (ab 16.4).

## Entscheidung
Web-Push (VAPID) für die PWA: Abo pro Gerät und Nutzer, Benachrichtigung bei neuer wichtiger Mail und wenn das Briefing bereitsteht. Inhalt nur Metadaten auf Minimum (z. B. „2 wichtige Mails“, optional Absendername), nie Mailinhalt. Schlüssel `VAPID_*` als Secret. Native App erst bei Bedarf mit eigener ADR.

## Folgen
- Neue Tabelle `push_subscriptions` (pro Nutzer), Service Worker bekommt `push`-Handler, weiterhin keine API-Antworten im Cache.
