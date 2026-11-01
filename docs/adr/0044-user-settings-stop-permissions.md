# 0044 Nutzereinstellungen: Not-Aus pro Nutzer, Berechtigung Modellwahl, Tageslimit pro Konto

- Status: angenommen
- Datum: 2026-11-01
- Bezug: setzt 0016 und 0025 (Teil 1) um, ergänzt 0041; `lib/user-settings.ts`, `lib/settings-api.ts`, Migration 010

## Kontext
R3 bringt die Schalter für „Spam als gelesen“ in die App. Der Not-Aus war bisher nur die Datei `auto-actions.disabled` (global). Die Modellwahl (0041) braucht eine Berechtigung pro Nutzer, die nur ein Admin vergibt.

## Entscheidung
- **Tabelle `user_settings`** (Migration 010, eine Zeile je Nutzer, angelegt beim ersten Schreiben): `classifier_choice` (Berechtigung, Standard aus), `classifier_model` (Wahl aus der Allowlist im Code), `auto_actions_stopped_at` (Not-Aus des Nutzers). Keine Zeile = Standard.
- **Not-Aus in zwei Stufen:** (1) die globale Datei bleibt; in der App ist sie für alle sichtbar (nur lesend) und für Admins nach Bestätigung schaltbar. (2) Der Not-Aus des Nutzers stoppt Planen, Schreiben und das Rückgängigmachen **seiner** Konten. `lib/mailbox-actions.ts` liest beides vor jeder Aktion; ein nicht lesbarer Nutzerzustand zählt als gestoppt (fail-closed). Das Trockenlauf-Rückgängigmachen (nur App-Status) bleibt erlaubt.
- **`live` nur durch den Nutzer in der App:** der API-Aufruf braucht `confirm: true` (die App sendet es erst nach dem Bestätigungsdialog); es gibt keinen Standardpfad nach `live`, Agenten haben keinen Zugriff auf die Route. Neue Konten starten mit `off`.
- **Tageslimit pro Konto**, nicht pro Nutzer: 200 Live-Aktionen in rollierenden 24 Stunden (wie implementiert, `DAILY_ACTION_LIMIT`); die App zeigt den Zähler je Konto.
- **Modellwahl:** Berechtigung nur durch Admins (`POST /api/settings/permissions`); Entzug setzt die Wahl zurück. Die Pipeline nutzt die Wahl nur mit Berechtigung, Allowlist und Kalibrierung, sonst Jev.
- Audit: nur Codes und Ids (`spam_seen_mode_changed` mit `from`/`to`, `user_stop_set|cleared`, `global_stop_set|cleared`, `classifier_model_changed`, `classifier_choice_granted|revoked` mit Ziel-Nutzer-Id).

## Folgen
- Migration 010 (008 ist der Erst-Import, 009 reserviert für Web Push).
- Ein Stop wirkt sofort für neue Auswertungen; bereits laufende Einzelaktionen in der Warteschlange prüfen den Zustand erneut (der Executor arbeitet seriell).
