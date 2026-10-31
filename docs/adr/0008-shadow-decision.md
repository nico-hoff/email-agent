# 0008 Schatten-Entscheidung, `security_auth` nie Kandidat

- Status: angenommen
- Datum: 2026-10-27
- Bezug: `docs/IMPLEMENTATION_PLAN_v4.md` (H11–H15), `lib/shadow.ts`, `lib/mailbox-rules.ts` (`PROTECTED_CATEGORIES`)

## Kontext
Bevor die App etwas automatisch tut, soll sichtbar sein, was sie tun *würde*.

## Entscheidung
Jede Klassifikation erzeugt eine Schatten-Entscheidung (`lib/shadow.ts`: Kandidat ja/nein plus Grundcode). `security_auth` (Logins, 2FA, Passwort-Reset) ist dort nie Kandidat (D15). Vor jeder echten Postfach-Aktion prüft `lib/mailbox-rules.ts` zusätzlich Schutz zuerst: geschützte Kategorien `security_auth` und `transactional` sowie Absender auf der Allowlist ⇒ keine Aktion.

## Folgen
- Reihenfolge in `mailbox-rules`: Schutz → schon gelesen → Jev `is_spam` positiv → Blacklist → Spam-Ordner des Providers.
- „Aussortiert“-Seite zeigt, was entschieden wurde und warum.
