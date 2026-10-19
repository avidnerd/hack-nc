# Decisions

One line per decision: date, decision, reason. Code carries a matching `// DECISION:` (or `# DECISION:`) comment where relevant.

- 2026-10-19: `CLAUDE.md` stays gitignored, as in v1. Reason: v1 kept agent notes out of the repo on purpose (`.gitignore`). There was no HackNC `CLAUDE.md` in this checkout, so `docs/CLAUDE_hacknc.md` was not created.
- 2026-10-19: Optimizer timing test takes the best of two runs and honours `PERF_SLACK` (CI sets 2). Reason: single cold timings ranged 405 to 650 ms on one machine under load; the worker pays JIT warm-up at case load, so the warm number is what a user sees.
- 2026-10-19: Frame time is measured by `scripts/frametime.mjs` into `metrics/frametime.json`, hands off. Reason: "measure, never estimate"; camera input cannot run under automation.
- 2026-10-19: Backend lives in `backend/` (FastAPI, Python 3.11, `uv`-managed). Token Factory is called with the `openai` Python SDK against its OpenAI-compatible base URL. Reason: one client for Token Factory and for our own vLLM endpoint, which is also OpenAI-compatible.
- 2026-10-19: LICENSE copyright holder is "the Scrub+ authors". Reason: no legal name given; change if the team wants names.
