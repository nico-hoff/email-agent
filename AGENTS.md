# Veryfront project guide

This is a Veryfront project. Veryfront is a framework for building and running AI apps and agents in TypeScript and React.

## Project conventions

Use these folders as runtime boundaries. Create folders only when the feature needs them.

- `app/`: pages, layouts, route handlers, and user-facing API routes.
- `agents/`: model reasoning and tool use.
- `tools/`: callable capabilities for agents and workflows.
- `workflows/`: multi-step coordination.
- `skills/`: reusable agent instructions in `skills/<id>/SKILL.md`.
- `veryfront.config.ts`: project metadata and router configuration.

## Developer loop

1. Start local development with `veryfront dev`.
2. Generate new files with `veryfront generate <type> <name>`.
3. Inspect current CLI commands with `veryfront schema --json`.
4. Verify discovered routes with `veryfront routes`.
5. Run focused tests and builds before shipping.
6. Use https://veryfront.com/docs when local files and CLI schema do not answer a Veryfront API or convention question.

## Coding agent loop

Prefer Veryfront scaffold tools over hand-written boilerplate. Keep app routes, agents, tools, workflows, and skills in their expected folders.

## Inference

Agent routes need model inference. Use a provider API key such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, configure an OpenAI-compatible local server, or run `veryfront login` to use the optional Veryfront Cloud gateway.

## Integrations

Integration tools such as `gmail__list_emails` use a provider account connected to a Veryfront project. `veryfront login` authenticates you to Veryfront and never connects a provider; `veryfront integration connect "<NAME>" --project "<PROJECT_SLUG>"` asks a person to authorize the provider account. Pass `--project` explicitly. For OAuth connectors (`credential_requirement.mode` is `oauth_connection`), select the account with `--connection` and `--expected-generation` from `veryfront integration connections`; project-credentials connectors use the project environment variables and take no connection selector. Never switch to another account or project to make a call succeed. Call once: never repeat a write whose outcome is unknown. Keep Veryfront tokens and provider secrets out of prompts, tool arguments, files, and output. Guide: https://veryfront.com/docs/code/guides/integrations

## E-Mail-Agent: verbindliche Projektregeln

Quelle der Wahrheit: `docs/IMPLEMENTATION_PLAN.md` (Arbeitsregeln in Abschnitt 3) und `docs/erd.md` (Schema). Kurzfassung der harten Regeln:

- Keine Mailbox-Schreibaktionen (verschieben, löschen, Flags, Entwürfe, senden). IMAP nur schreibgeschützt.
- Keine Mailinhalte persistieren (kein Body, Auszug, Rohquelle, Roh-Response) und nie in Logs, API, Dashboard oder Fixtures. Fixtures nur synthetisch.
- Secrets (`.env`, `.env.local`, `.mcp.json`, Konten-Datei) nie lesen, ausgeben oder committen.
- Jev nur über `@openrouter/sdk` System One (`typesafe/jev-1.13`), kein Chat-Agent. Keine erfundenen SDK-Felder: Context7, dann installierte Typen, dann echte synthetische Fixtures.
- Node 26.12.1 exakt, npm. Von Node direkt ausgeführter Code importiert mit `.ts`-Endung und nutzt nur löschbare TypeScript-Syntax.
- Nie pushen, nie `git add -A`; nur die im Task genannten Dateien committen. Bei Unklarheit stoppen statt raten.
