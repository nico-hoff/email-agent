# 0030 Follow-ups und Erinnerungen

- Status: angenommen (Stufe 1); Stufe 2 vorgeschlagen
- Datum: 2026-10-31
- Bezug: Wunsch Nico 2026-10-31, 0027 (Web-Push), 0029, `docs/veryfront-guide.md` (Workflows)

## Kontext
Der Agent soll an Dinge erinnern: „Antwort auf Mail X fehlt seit 5 Tagen“, „Frist am Freitag“, „nachhaken, falls keine Antwort kommt“. Veryfront-Workflows können warten (`waitForEvent`, Zeitlimit, `waitForApproval`), speichern ihren Zustand aber nur im Speicher (`MemoryBackend`) oder in Redis. Veryfronts `RedisBackend` nutzt Lua-Skripte (`EVAL`, ~250 `redis.call`) und Streams; Redis-Nachbauten auf SQLite (z. B. Redka) decken das nicht verlässlich ab. Echtes Redis wäre ein zusätzlicher Dienst (Kosten, Drittanbieter). Die Schnittstelle `WorkflowBackend` ist austauschbar (Pflicht: `createRun`, `getRun`, `updateRun`, `listRuns`, `saveCheckpoint`, `getLatestCheckpoint`, `savePendingApproval`, `getPendingApprovals`, `updateApproval`; optional Queue, Locks, Stalled-Runs).

## Entscheidung
**Stufe 1 (jetzt):** eigene Tabelle `follow_ups` (pro `user_id`: `email_id`, `due_at`, `kind` (`reply_missing|deadline|custom`), `reason_code`, `status` (`open|done|snoozed|cancelled`), `created_by` (`user|agent`)). Ein Durchlauf im bestehenden Worker prüft fällige Einträge und schickt Web-Push (0027) mit Minimal-Metadaten. Erledigt sich automatisch, wenn eine Antwort im Thread erkannt wird oder die Mail als erledigt markiert ist. Agent-Tool `create_follow_up` (typisiert, mit Gate: nur für eigene, klassifizierte Mails, Frist in sinnvollem Bereich, Tageslimit). UI: Liste „Erinnerungen“, Snooze, Erledigt.
**Stufe 2 (bei Bedarf):** `SqliteWorkflowBackend` als eigene Implementierung von Veryfronts `WorkflowBackend` auf `node:sqlite` (ein Prozess, Locks trivial), falls mehrstufige Abläufe mit `waitForEvent`/`waitForApproval` gebraucht werden. Kein Redis.

## Folgen
- Workflow-Zustand und `follow_ups` enthalten nie Mailinhalte (nur IDs, Zeiten, Codes); Workflow-Kontext ist JSON und wird geprüft.
- Stufe 2 hängt an einer internen Veryfront-Schnittstelle (0.1.x) → Vertragstest gegen die Pflichtmethoden, Pin der Version.
