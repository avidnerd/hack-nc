# Scrub+ v2. `make help` lists targets.
.PHONY: deploy results distill-train vista-smoke vista-gallery help install dev backend web test test-web test-backend e2e secrets frametime tf-check parity tool-parity commands distill distill-check eval

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

tool-parity: ## Run tests/fixtures/tool_script.json through the TS executor (browser), then check the Python one gives the same JSON
	TOOL_PARITY_WRITE=1 npx playwright test e2e/toolParity.spec.ts --workers=1
	cd backend && uv run pytest -q tests/test_tool_parity.py

e2e: ## Playwright smoke tests
	npx playwright test

secrets: ## Scan tracked files for API keys
	scripts/check-secrets.sh --all

frametime: ## Measure render frame time (needs `make web` running)
	node scripts/frametime.mjs

tf-check: ## List Token Factory models and run one Super tool call
	cd backend && uv run python scripts/tf_check.py

commands: ## Generate the surgeon-command set (add PARAPHRASE=1 to use Super)
	cd backend && uv run python ../distill/gen_commands.py $(if $(PARAPHRASE),--paraphrase,)

distill: commands ## Teacher traces -> verify -> SFT files (needs Token Factory key)
	cd backend && uv run python ../distill/teach.py
	cd backend && uv run python ../distill/verify.py ../distill/data/traces_$$(grep NEBIUS_TF_MODEL_SUPER ../.env | cut -d= -f2 | tr / _).jsonl
	cd backend && uv run python ../distill/export_sft.py ../distill/data/traces_$$(grep NEBIUS_TF_MODEL_SUPER ../.env | cut -d= -f2 | tr / _)_verified.jsonl

distill-check: ## Pipeline self-check: oracle policy through solve + verify (no network)
	cd backend && uv run python ../distill/teach.py --oracle --split train,val,test --workers 1
	cd backend && uv run python ../distill/verify.py ../distill/data/traces_oracle.jsonl

eval: ## Eval every configured model on the test split -> metrics/results.json
	cd backend && uv run python ../distill/eval.py run --model super
	cd backend && if [ -n "$$NANO_BASE_URL" ]; then uv run python ../distill/eval.py run --model nano && uv run python ../distill/eval.py run --model nano-lora; fi
	cd backend && uv run python ../distill/eval.py report

vista-smoke: ## VISTA-3D full-scan Job on one MSD case (Nebius Serverless, H100)
	bash vista/job/launch.sh vista/job/batch_smoke.json

vista-gallery: ## VISTA-3D full-scan Job on the 8 gallery cases, with Dice against MSD labels
	bash vista/job/launch.sh vista/job/batch_gallery.json

distill-train: ## LoRA fine-tune Nano 9B v2 on the verified traces (Nebius Serverless Job, H100)
	bash distill/job/launch.sh

results: ## Rebuild docs/RESULTS.md from metrics/ (agent table + VISTA-3D table)
	{ printf '# Results\n\nEvery number here comes from a file in `metrics/`. Unmeasured cells show `—`.\n\n'; python3 distill/report.py; python3 vista/report.py; } > docs/RESULTS.md

deploy: ## Deploy the backend as a CPU Nebius Serverless Endpoint (eu-south1) at the pushed HEAD
	bash backend/deploy.sh
