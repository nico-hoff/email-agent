# 0017 Absender-Regeln und HITL nach drei Spam-Urteilen

- Status: angenommen
- Datum: 2026-10-30
- Bezug: Plan v5 M5, `lib/mailbox-rules.ts`, `app/api/senders/*`, Migration 004

## Kontext
Wiederkehrende Absender sollen dauerhaft entschieden werden, aber nicht ohne Nico.

## Entscheidung
Nach 3 Jev-Spam-Urteilen für einen Absender fragt die App (HITL): dauerhaft Allowlist oder Blacklist. Eine Domain wird vorgeschlagen, wenn ≥ 2 Adressen dieser Domain betroffen sind; Freemail-Domains nie. Regeln sind deaktivierbar, nicht löschbar (Audit). Feedback aus der Detailansicht fließt in Kalibrierung und Jev-State.

## Folgen
- Allowlist schützt vor Auto-Aktionen (0008); Blacklist-Löschen kommt erst mit M7.
