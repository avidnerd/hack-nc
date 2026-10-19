# Decisions

One line per decision: date, decision, reason. Code carries a matching `// DECISION:` (or `# DECISION:`) comment where relevant.

- 2026-10-19: `CLAUDE.md` stays gitignored, as in v1. Reason: v1 kept agent notes out of the repo on purpose (`.gitignore`). There was no HackNC `CLAUDE.md` in this checkout, so `docs/CLAUDE_hacknc.md` was not created.
- 2026-10-19: Optimizer timing test takes the best of two runs and honours `PERF_SLACK` (CI sets 2). Reason: single cold timings ranged 405 to 650 ms on one machine under load; the worker pays JIT warm-up at case load, so the warm number is what a user sees.
- 2026-10-19: Frame time is measured by `scripts/frametime.mjs` into `metrics/frametime.json`, hands off. Reason: "measure, never estimate"; camera input cannot run under automation.
- 2026-10-19: Backend lives in `backend/` (FastAPI, Python 3.11, `uv`-managed). Token Factory is called with the `openai` Python SDK against its OpenAI-compatible base URL. Reason: one client for Token Factory and for our own vLLM endpoint, which is also OpenAI-compatible.
- 2026-10-19: LICENSE copyright holder is "the Scrub+ authors". Reason: no legal name given; change if the team wants names.
- 2026-10-19: "Nano few-shot" baseline = our `scrub-nano` endpoint serving Nano 9B v2 without the LoRA. Reason: Token Factory does not list Nano 9B v2 (PLATFORM_NOTES section 2); the brief's fallback applies. Nemotron 3.5 Lightning on Token Factory may be added as an extra row only if verified to support tools.
- 2026-10-19: LoRA targets attention and MLP projections only (q/k/v/o_proj, up/down_proj), not the Mamba in_proj/out_proj. Reason: vLLM documents LoRA for NemotronH but not for the Mamba layers; this keeps the adapter servable without merging.
- 2026-10-19: VISTA-3D full-scan job requests hepatic tumor (26) and hepatic vessel (25) by class id in addition to "everything". Reason: both are excluded from the default 117-class set.
