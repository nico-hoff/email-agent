# Startprompt für den Implementierer (Claude Code, Opus)

Vor dem Einfügen erledigt Nico:

- [ ] `.env.local` im Repo-Root enthält `OPENROUTER_API_KEY` (Wert nur lokal). `ACCOUNTS_FILE` und `DATABASE_PATH` sind optional, Defaults sind `data/accounts.json` und `data/email-agent.sqlite`.
- [ ] OpenRouter-Guthaben für `typesafe/jev-1.13` ist vorhanden.
- [ ] Claude Code läuft im Repo-Root (`/Users/nicolaihoff/Projects/email-agent`) mit Zugriff auf Git, npm, Docker und (optional) Context7.

Dann diesen Prompt einfügen:

```
Du setzt in diesem Repo (E-Mail-Agent, Veryfront + Jev) einen fertigen Plan um.

1. Lies vollständig und in dieser Reihenfolge: AGENTS.md, docs/erd.md, docs/IMPLEMENTATION_PLAN.md.
2. Nur diese drei Dateien sind verbindlich. `.hermes/plans/*` und `HANDOVER.md` sind überholt (nur Historie).
3. Lege eine Task-Liste an (P, T1–T22) und arbeite sie strikt in dieser Reihenfolge ab. Pro Task: Test zuerst (RED sichtbar), minimale Implementierung, Typecheck und Gesamtsuite, dann Commit nur der im Task genannten Dateien. Nie pushen, nie `git add -A`.
4. Halte dich an Abschnitt 3 (Arbeitsregeln, harte Regeln H1–H10) und stoppe bei jedem dort definierten STOP-Punkt mit einer kurzen Meldung, statt zu raten. Keine erfundenen SDK-Felder: erst Context7, dann installierte Typen, dann echte synthetische Fixtures.
5. Ich bestätige hiermit: OpenRouter-Key und Guthaben sind vorhanden, und die Jev-Proben in T3 und T12 sowie ein Lauf von eval:jev in T18 sind mit ausschließlich synthetischen Daten autorisiert. Gegen echte Postfächer läufst du nie (kein IMAP, kein sample); das mache ich am Freigabepunkt selbst.
6. Beende beim Freigabepunkt (Abschnitt 7) mit dem dort geforderten Bericht und warte auf mich.

Beginne jetzt mit dem Preflight (Abschnitt 6, P).
```
