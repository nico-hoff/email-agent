# Kurzbefehle. Secrets kommen nur aus der lokalen, git-ignorierten Env-Datei (.env.local, sonst .env)
# und gehen nur über stdin an fly. Nichts davon landet im Repo. Details: docs/fly-deploy.md

NODE ?= node
FLY ?= fly
ENV_FILE ?=
APP ?=

SECRETS_ARGS = $(if $(ENV_FILE),--env-file $(ENV_FILE)) $(if $(APP),--app $(APP))
FLY_APP_ARG = $(if $(APP),--app $(APP))

.PHONY: help verify fly-secrets-check fly-secrets-status fly-secrets-sync fly-secrets-stage fly-deploy fly-status

help: ## Diese Übersicht
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-20s %s\n", $$1, $$2}'

verify: ## Push-Gate: Typecheck, Tests, Build, Offline-Evals, E2E-Smoke
	npm run typecheck
	npm test -- tests/*.test.ts
	npm run build
	npm run eval
	npm run smoke:e2e

fly-secrets-check: ## Env-Datei prüfen und Plan zeigen (nur Namen, kontaktiert fly nicht)
	$(NODE) scripts/fly-secrets.ts check $(SECRETS_ARGS)

fly-secrets-status: ## wie check, plus Abgleich der Namen mit fly secrets list
	FLY_BIN=$(FLY) $(NODE) scripts/fly-secrets.ts status $(SECRETS_ARGS)

fly-secrets-sync: ## Secrets an fly senden (startet die Machine neu)
	FLY_BIN=$(FLY) $(NODE) scripts/fly-secrets.ts sync $(SECRETS_ARGS)

fly-secrets-stage: ## Secrets senden ohne Neustart (wirken beim nächsten fly deploy)
	FLY_BIN=$(FLY) $(NODE) scripts/fly-secrets.ts sync --stage $(SECRETS_ARGS)

fly-deploy: fly-secrets-check ## Pflicht-Secrets prüfen, dann fly deploy
	$(FLY) deploy $(FLY_APP_ARG)

fly-status: ## Machine-Status
	$(FLY) status $(FLY_APP_ARG)
