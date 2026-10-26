@AGENTS.md

Verbindlich für jede Implementierungsarbeit in diesem Repo: `docs/IMPLEMENTATION_PLAN.md` (Abschnitt 3: Arbeitsregeln, harte Regeln H1–H10, STOP-Punkte) und `docs/erd.md` (Schema). `.hermes/plans/*` und `HANDOVER.md` sind überholt.

## Externe Dokumentation: Context7 zuerst

Context7 ist die primäre Quelle für jede externe Doku (Veryfront, OpenRouter SDK, ImapFlow, mailparser, zod, Node, …). Vor jeder Nutzung einer externen API: `resolve-library-id`, dann `query-docs`. Bekannte IDs: `/websites/veryfront`, `/openrouterteam/typescript-sdk`, `/postalsys/imapflow`. Erst danach installierte Typdeklarationen und echte synthetische Fixtures (H6). Kein Raten aus dem Gedächtnis; Widersprüche → STOP-5.
