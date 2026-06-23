# Operation Echo Shield — developer tooling.
#
# Quick start:
#   make up        # build + start the whole stack (detached)
#   make health    # check /health on every service
#   make smoke     # run the 10 interop checks
#   make logs      # follow logs
#   make down      # stop the stack
#
# All targets shell out to docker compose / the scripts in ./scripts.

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

COMPOSE := docker compose
SCRIPTS := ./scripts

.PHONY: help build up down restart logs ps reset mission smoke health clean validate demo-resilience demo-version

help: ## Show this help.
	@echo "Operation Echo Shield — make targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Build all service images.
	$(COMPOSE) build

up: ## Build and start the whole stack (detached).
	$(COMPOSE) up --build -d

down: ## Stop the stack and remove containers.
	$(COMPOSE) down

restart: ## Restart the stack (down then up).
	$(COMPOSE) down
	$(COMPOSE) up --build -d

logs: ## Follow logs from all services.
	$(COMPOSE) logs -f

ps: ## Show running services.
	$(COMPOSE) ps

reset: ## Wipe the shared DB volume and restart fresh.
	$(SCRIPTS)/reset-db.sh

mission: ## Re-run Operation Echo Shield via the command agent.
	$(SCRIPTS)/run-mission.sh

smoke: ## Run the 10 cross-language interop checks.
	$(SCRIPTS)/smoke-test.sh

health: ## Curl /health on all 8 services.
	$(SCRIPTS)/healthcheck.sh

validate: ## Validate shared examples + live agent cards against JSON Schemas.
	$(SCRIPTS)/validate-schemas.sh

demo-resilience: ## Demo retry/backoff + dead-letter queue (FAILURE_SIMULATION).
	$(SCRIPTS)/failure-sim-demo.sh

demo-version: ## Demo A2A protocol version-mismatch rejection (VERSION_NOT_SUPPORTED).
	$(SCRIPTS)/version-mismatch-demo.sh

clean: ## Stop the stack and remove containers, images, and volumes.
	$(COMPOSE) down --rmi local --volumes --remove-orphans
