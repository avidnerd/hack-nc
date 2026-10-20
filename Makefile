# Scrub+ v2. `make help` lists targets.
.PHONY: help install dev backend web test test-web test-backend e2e secrets frametime tf-check parity

help:
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

install: ## Install web and backend dependencies, enable the secret hook
	npm ci
	cd backend && uv sync --python 3.11
	git config core.hooksPath .githooks

backend: ## Run the FastAPI backend on :8787
	cd backend && uv run uvicorn app.main:app --reload --port 8787

web: ## Run the Vite dev server on :5173 (proxies /api/agent to :8787)
	npm run dev

dev: ## Backend and web together
	$(MAKE) -j2 backend web

test: test-web test-backend ## Unit tests (vitest + pytest)

test-web:
	npm run -s typecheck && npm run -s lint && npx vitest run

test-backend:
	cd backend && uv run pytest -q

parity: ## Re-dump TS engine numbers to tests/fixtures/parity.json and check the Python engine
	node --experimental-transform-types scripts/parity_dump.ts
	cd backend && uv run pytest -q tests/test_engine_parity.py

e2e: ## Playwright smoke tests
	npx playwright test

secrets: ## Scan tracked files for API keys
	scripts/check-secrets.sh --all

frametime: ## Measure render frame time (needs `make web` running)
	node scripts/frametime.mjs

tf-check: ## List Token Factory models and run one Super tool call
	cd backend && uv run python scripts/tf_check.py
